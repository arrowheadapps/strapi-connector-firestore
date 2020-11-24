import * as _ from 'lodash';
import { getComponentModel } from './utils/validate-components';
import { coerceReference } from './utils/coerce';
import type { FirestoreConnectorModel } from './types';
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
  docData[model.primaryKey] = docSnap.ref.id;

  if (_.isArray(model.options.timestamps)) {
    const [createdAtKey, updatedAtKey] = model.options.timestamps;
    convertTimestampToDate(docData, createdAtKey);
    convertTimestampToDate(docData, updatedAtKey);
  }

  // Firestore returns all integers as BigInt
  // Convert back to number unless it is supposed to be BigInt
  Object.keys(model.attributes).forEach(key => {
    const attr = model.attributes[key];
    if ((typeof docData[key] === 'bigint') && (attr.type !== 'biginteger')) {
      docData[key] = Number(docData[key]);
    }
  });
}


export async function populateDocs(model: FirestoreConnectorModel, docs: PartialDocumentSnapshot[], populateFields: string[], transaction: TransactionWrapper) {
  const docsData: any[] = [];
  const subDocs: { doc: Reference, data?: any, assign: (snap: PartialDocumentSnapshot) => void }[] = [];

  await Promise.all(docs.map(doc => {
    const data = Object.assign({}, doc.data());
    if (!data) {
      throw new Error(`Document not found: ${doc.ref.path}`);
    }

    assignMeta(model, doc, data);
    docsData.push(data);

    const populateData = async (model: FirestoreConnectorModel, f: string, data: any) => {
      const details = model.associations.find(assoc => assoc.alias === f)!;
      const assocModel = strapi.db.getModelByAssoc(details);
    
      if (!assocModel) {
        // TODO:
        // This seems to happen for polymorphic relations such as images
        // Can we just safely ignore this?
        //throw new Error(`Associated model not found for model: "${details.model || details.collection}" plugin: "${details.plugin}"`);

        return;
      }

      const processPopulatedDoc = (snap: PartialDocumentSnapshot) => {
        const data = snap.data();
        if (data) {
          assignMeta(assocModel, snap, data);
        }
        return data;
      }
    
      if (!data[f]) {
        // TODO: In theory we only populate relations that aren't dominant
        // but there are some cases where we need to (e.g. oneToMany)
        // Not sure what needs to be done here but for now, just populate everything
        // that has been requested
        const dominant = false; //details.dominant
        if (!dominant) {
          const via = details.via || details.alias;
          const assocDetails = assocModel.associations.find(assoc => assoc.alias === via);
          if (!assocDetails) {
            throw new Error(`No configuration found for attribute "${via}"`);
          }

          // If the attribe in the related model has `model`
          // then it is a one-way relation
          // otherwise it has `collection` and it is a multi-way relation
          const q = assocDetails.model
            ? assocModel.db.where(via, '==', doc.ref)
            : assocModel.db.where(via, 'array-contains', doc.ref);

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
        }
        
      } else if (Array.isArray(data[f])) {
    
        // oneToMany or manyToMany etc
        // Expects array of DocumentReference instances
        data[f].forEach(ref => {
          subDocs.push({
            doc: coerceReference(ref, assocModel) as Reference,
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
          doc: coerceReference(data[f], assocModel) as Reference,
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
          if (c) {
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
    if (!subDocSnap.exists) {
      strapi.log.warn(`Missing relation "${typeof subDocSnap.ref === 'string' ? subDocSnap.ref : subDocSnap.ref.path}"`);
    }
    assign(subDocSnap);
  });

  return docsData;
};
