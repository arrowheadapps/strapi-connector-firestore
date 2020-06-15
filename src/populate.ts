import * as _ from 'lodash';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { FirestoreConnectorModel } from './types';
import type { DocumentSnapshot, DocumentReference, DocumentData, Transaction, Query } from '@google-cloud/firestore';

function convertTimestampToDate(data: any, key: string) {
  const value = data[key];
  if (value && typeof value.toDate === 'function') {
    data[key] = value.toDate();
  }
}

function assignMeta(model: FirestoreConnectorModel, docSnap: Partial<DocumentSnapshot>, docData: any) {
  docData[model.primaryKey] = docSnap.id;

  if (_.isArray(model.options.timestamps)) {
    const [createdAtKey, updatedAtKey] = model.options.timestamps;
    convertTimestampToDate(docData, createdAtKey);
    convertTimestampToDate(docData, updatedAtKey);
  }
}


export async function populateDocs(model: FirestoreConnectorModel, docs: { id: string, ref: DocumentReference, data: () => any }[], populateFields: string [], transaction?: Transaction) {
  const docsData: any[] = [];
  const subDocs: { doc: DocumentReference, data?: any, assign: (data: DocumentData) => void }[] = [];

  await Promise.all(docs.map(doc => {
    const data = Object.assign({}, doc.data());
    if (!data) {
      throw new Error(`Document not found: ${doc.ref.path}`);
    }

    assignMeta(model, doc, data);
    docsData.push(data);

    const populateData = async (model: FirestoreConnectorModel, f: string, data: any) => {
      const details = model._attributes[f];
      const assoc = model.associations.find(a => a.alias === f)!;
      const assocModel = getModel(details.model || details.collection, details.plugin);
    
      if (!assocModel) {
        // This seems to happen for polymorphic relations such as images
        // Can we just safely ignore this?
        return;
      }
    
      if (!data[f]) {
        // For the following types of relations
        // The list is maintained in the related object not this one
        //  - oneToMany
    
        let q: Query
        switch (assoc.nature) {
          case 'oneToMany':
          case 'manyToMany':
          // TODO: FIXME: I'm pretty sure the morph lookups won't work
          case 'manyToManyMorph':
          case 'manyMorphToMany':
          case 'oneMorphToMany':
          case 'oneToManyMorph':
            q = assocModel.where(details.via, 'array-contains', doc.ref || model.doc(doc.id));
            break;
    
          case 'manyToOne':
          case 'manyWay':
          case 'oneToOne':
          case 'oneWay':
          // TODO: FIXME: I'm pretty sure the morph lookups won't work
          case 'oneMorphToOne':
          case 'manyMorphToOne':
            q = assocModel.where(details.via, '==', doc.ref || model.doc(doc.id));
            break;
        }
    
        const snaps = (await (transaction ? transaction.get(q) : q.get())).docs;
        data[f] = snaps.map(snap => {
          const d = snap.data();
          // Remove second level relations
          assocModel.assocKeys.forEach(k => delete d[k]);
          assignMeta(assocModel, snap, d);
          return d;
        });
        
      } else if (Array.isArray(data[f])) {
    
        // oneToMany or manyToMany etc
        // Expects array of DocumentReference instances
        data[f].forEach(ref => {
          subDocs.push({
            doc: getDocRef(ref, assocModel) as DocumentReference,
            assign: (d) => {
              // Remove second level relations
              assocModel.assocKeys.forEach(k => delete d[k]);
              data[f].push(d);
            }
          });
        });
        // Erase doc references with empty array
        // waiting for the document data to be populated
        data[f] = [];
      } else {
        // oneToOne or manyToOne etc
        subDocs.push({
          doc: getDocRef(data[f], assocModel) as DocumentReference,
          assign: (d) => {
            // Remove second level relations
            assocModel.assocKeys.forEach(k => delete d[k]);
            data[f] = d;
          }
        });
      }
    }

    const relationPromises =  Promise.all(populateFields.map(f => populateData(model, f, data)));

    const componentPromises = Promise.all(model.componentKeys.map(async componentKey => {
      const component = data[componentKey];
      if (component) {
        await Promise.all(_.castArray(component).map(async c => {
          const componentModel = strapi.components[c.__component];
          await Promise.all(componentModel.defaultPopulate.map(async field => {
            await populateData(componentModel, field, c);
          }));
        }));
      }
    }));

    return Promise.all([relationPromises, componentPromises]);
  }));

  // Get all the documents all at once
  const subDocsData = subDocs.length
    ? await (transaction || model.firestore).getAll(...subDocs.map(d => d.doc))
    : [];

  // Assign all the fetched data
  subDocsData.forEach((subDocSnap, i) => {
    const { assign } = subDocs[i];
    const data = subDocSnap.data();
    if (data) {
      assignMeta(model, subDocSnap, data);
      assign(data);
    } else {
      // How to handle a not found document
      throw new Error(`relation not found: ${subDocSnap.ref.path}`);
    }
  });

  return docsData;
};
