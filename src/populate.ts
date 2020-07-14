import * as _ from 'lodash';
import { coerceToReference, getModel, parseRef } from './utils/doc-ref';
import { getComponentModel } from './utils/validate-components';
import type { FirestoreConnectorModel } from './types';
import type { DocumentReference } from '@google-cloud/firestore';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference } from './utils/queryable-collection';

export interface PartialDocumentSnapshot {
  ref: Reference
  data: () => any
}

function convertTimestampToDate(data: any, key: string) {
  const value = data[key];
  if (value && typeof value.toDate === 'function') {
    data[key] = value.toDate();
  }
}

function assignMeta(model: FirestoreConnectorModel, docSnap: PartialDocumentSnapshot, docData: any) {
  docData[model.primaryKey] = parseRef(docSnap.ref, model.firestore).id;

  if (_.isArray(model.options.timestamps)) {
    const [createdAtKey, updatedAtKey] = model.options.timestamps;
    convertTimestampToDate(docData, createdAtKey);
    convertTimestampToDate(docData, updatedAtKey);
  }
}


export async function populateDocs(model: FirestoreConnectorModel, docs: PartialDocumentSnapshot[], populateFields: string [], transaction: TransactionWrapper) {
  const docsData: any[] = [];
  const subDocs: { doc: DocumentReference, data?: any, assign: (snap: PartialDocumentSnapshot) => void }[] = [];

  await Promise.all(docs.map(doc => {
    const data = Object.assign({}, doc.data());
    if (!data) {
      throw new Error(`Document not found: ${parseRef(doc.ref, model.firestore).path}`);
    }

    assignMeta(model, doc, data);
    docsData.push(data);

    const populateData = async (model: FirestoreConnectorModel, f: string, data: any) => {
      const details = model.attributes[f];
      const assocModel = getModel(details.model || details.collection, details.plugin);
    
      if (!assocModel) {
        // This seems to happen for polymorphic relations such as images
        // Can we just safely ignore this?
        throw new Error(`Associated model not found for model: "${details.model || details.collection}" plugin: "${details.plugin}"`);
      }

      const processPopulatedDoc = (snap: PartialDocumentSnapshot) => {
        const data = snap.data();

        // Remove second level relations
        assocModel.assocKeys.forEach(k => delete data[k]);
        
        assignMeta(assocModel, snap, data);
        return data;
      }
    
      if (!data[f]) {
        const assocDetails = assocModel.attributes[details.via];

        // If the attribe in the related model has `model`
        // then it is a one-way relation
        // otherwise it has `collection` and it is a multi-way relation
        const q = assocDetails.model
          ? assocModel.db.where(details.via, '==', doc.ref)
          : assocModel.db.where(details.via, 'array-contains', doc.ref);

        const snaps = (await transaction.get(q)).docs;
        
        if (details.model) {
          // This is a one-way relation
          data[f] = snaps.length
            ? processPopulatedDoc(snaps[0])
            : null;
        } else {
          // This is a multi-way relation
          data[f] = snaps.map(processPopulatedDoc);
        }
        
      } else if (Array.isArray(data[f])) {
    
        // oneToMany or manyToMany etc
        // Expects array of DocumentReference instances
        data[f].forEach(ref => {
          subDocs.push({
            doc: coerceToReference(ref, assocModel) as DocumentReference,
            assign: (snap) => {
              data[f].push(processPopulatedDoc(snap));
            }
          });
        });
        // Erase doc references with empty array
        // waiting for the document data to be populated
        data[f] = [];
      } else {
        // oneToOne or manyToOne etc
        subDocs.push({
          doc: coerceToReference(data[f], assocModel) as DocumentReference,
          assign: (snap) => {
            data[f] = processPopulatedDoc(snap);
          }
        });
      }
    }

    const relationPromises =  Promise.all(populateFields.map(f => populateData(model, f, data)));

    const componentPromises = Promise.all(model.componentKeys.map(async componentKey => {
      const component = data[componentKey];
      if (component) {
        await Promise.all(_.castArray(component).map(async c => {
          if (c[componentKey]) {
            const componentModel = getComponentModel(model, componentKey, c);
            await Promise.all(componentModel.defaultPopulate.map(async field => {
              await populateData(componentModel, field, c);
            }));
          }
        }));
      }
    }));

    return Promise.all([relationPromises, componentPromises]);
  }));

  // Get all the documents all at once
  const subDocsData = subDocs.length
    ? await transaction.getAll(...subDocs.map(d => d.doc))
    : [];

  // Assign all the fetched data
  subDocsData.forEach((subDocSnap, i) => {
    const { assign } = subDocs[i];
    if (subDocSnap.exists) {
      assign(subDocSnap);
    } else {
      throw new Error(`Relation not found: ${subDocSnap.ref.path}`);
    }
  });

  return docsData;
};
