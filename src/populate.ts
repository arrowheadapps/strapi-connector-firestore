import * as _ from 'lodash';
import { getComponentModel } from './utils/validate-components';
import { coerceReference } from './utils/coerce';
import type { FirestoreConnectorModel } from './types';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference, Snapshot } from './utils/queryable-collection';
import { StatusError } from './utils/status-error';


export type PartialSnapshot = Pick<Snapshot, 'data'> & Pick<Snapshot, 'ref'>


/**
 * Populates all the requested relational field on the given documents.
 */
export async function populateDocs(model: FirestoreConnectorModel, docs: PartialSnapshot[], populateFields: string[], transaction: TransactionWrapper) {
  return await Promise.all(docs.map(doc => populateDoc(model, doc, populateFields, transaction)));
};


/**
 * Populates all the requested relational field on the given document.
 */
export async function populateDoc(model: FirestoreConnectorModel, doc: PartialSnapshot, populateFields: string[], transaction: TransactionWrapper) {
  const data = Object.assign({}, doc.data());
  if (!data) {
    throw new StatusError(`Document not found: ${doc.ref.path}`, 404);
  }

  const relationPromises =  Promise.all(populateFields.map(f => populateField(model, doc.ref, f, data, transaction)));

  const componentPromises = Promise.all(model.componentKeys.map(async componentKey => {
    const component = data[componentKey];
    if (component) {
      await Promise.all(_.castArray(component).map(async c => {
        if (c) {
          const componentModel = getComponentModel(model, componentKey, c);
          await Promise.all(componentModel.defaultPopulate.map(async field => {
            await populateField(componentModel, doc.ref, field, c, transaction);
          }));
        }
      }));
    }
  }));

  await Promise.all([relationPromises, componentPromises]);

  return data;
}


export async function populateField(model: FirestoreConnectorModel, docRef: Reference, field: string, data: any, transaction: TransactionWrapper) {
  const details = model.associations.find(assoc => assoc.alias === field)!;
  const assocModel = strapi.db.getModelByAssoc(details);

  // if (!assocModel) {
  //   // TODO:
  //   // This seems to happen for polymorphic relations such as images
  //   // Can we just safely ignore this?
  //   //throw new Error(`Associated model not found for model: "${details.model || details.collection}" plugin: "${details.plugin}"`);

  //   return;
  // }

  const processPopulatedDoc = (snap: Snapshot) => {
    const data = snap.data();
    if (!data) {
      // TODO:
      // Should we through an error if the reference can't be found
      // or just silently omit it?
      // For now we log a warning
      strapi.log.warn(`The document referenced by "${snap.ref.path}" no longer exists`);
    }
    return data || null;
  }


  if (details.dominant) {
    // If the attribute is the dominant end of the relation
    // then its data will contain the reference to the other end
    const ref = coerceReference(data[field], assocModel);
    if (ref) {
      if (Array.isArray(ref)) {
        data[field] = await transaction.getAll(...ref).then(docs => docs.map(processPopulatedDoc).filter(doc => doc != null));
      } else {
        data[field] = processPopulatedDoc(await transaction.get(ref));
      }
    } else {
      if (data[field]) {
        // Relation has a value but it could not be coerced to a reference
        throw new Error(`Attribute value for "${field}" could not be coerced to a reference`);
      } else {
        // Empty relation
        if (details.collection) {
          data[field] = [];
        } else {
          data[field] = null;
        }
      }
    }


  } else {
    // I.e. details.dominant == false
    // If we get here then there was no value populated
    const via = details.via || details.alias;
    const assocDetails = assocModel.associations.find(assoc => assoc.alias === via);
    if (!assocDetails) {
      throw new Error(`No configuration found to populate attribute "${via}"`);
    }

    // If the attribe in the related model has `model` then it is a one-way relation
    // otherwise it has `collection` and it is a multi-way relation
    // The model's own converters be called
    let q = assocDetails.model
      ? assocModel.db.where(via, '==', docRef)
      : assocModel.db.where(via, 'array-contains', docRef);

    // It's a one-way relation so we only want a single value
    const oneWay = details.model;
    if (oneWay) {
      q = q.limit(1);
    }

    const { docs } = await transaction.get(q);
    if (oneWay) {
      // This is a one-way relation
      data[field] = docs.length ? processPopulatedDoc(docs[0]) : null;
    } else {
      // This is a multi-way relation
      data[field] = docs.map(processPopulatedDoc);
    }
  }
}
