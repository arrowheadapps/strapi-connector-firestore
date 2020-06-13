import * as _ from 'lodash';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { FirestoreConnectorModel } from './types';
import type { DocumentSnapshot, DocumentReference, DocumentData, Transaction } from '@google-cloud/firestore';

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

    return Promise.all(populateFields
      .map(async f => {
        const details = model._attributes[f];
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
          const q = assocModel.where(details.via, '==', doc.ref || model.doc(doc.id));
          const snaps = (await (transaction ? transaction.get(q) : q.get())).docs;
          data[f] = snaps.map(snap => {
            const d = snap.data();
            assignMeta(assocModel, snap, d);
            return d;
          });
          
        } else if (Array.isArray(data[f])) {

          // oneToMany or manyToMany etc
          // Expects array of DocumentReference instances
          data[f].forEach(ref => {
            subDocs.push({
              doc: getDocRef(ref, assocModel) as DocumentReference,
              assign: (d) => data[f].push(d)
            });
          });
          // Erase doc references with empty array
          // waiting for the document data to be populated
          data[f] = [];
        } else {
          // oneToOne or manyToOne etc
          subDocs.push({
            doc: getDocRef(data[f], assocModel) as DocumentReference,
            assign: (d) => data[f] = d
          });
        }
      }));
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