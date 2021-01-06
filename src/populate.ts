import * as _ from 'lodash';
import { getComponentModel } from './utils/components';
import type { FirestoreConnectorModel } from './model';
import type { Snapshot } from './utils/queryable-collection';
import type { Transaction } from './utils/transaction';
import { StatusError } from './utils/status-error';
import type { AttributeKey } from './types';


export type PartialSnapshot<T extends object> = Pick<Snapshot<T>, 'data'> & Pick<Snapshot<T>, 'ref'>


/**
 * Populates all the requested relational field on the given documents.
 */
export async function populateDocs<T extends object>(model: FirestoreConnectorModel<T>, docs: PartialSnapshot<T>[], populate: AttributeKey<T>[], transaction: Transaction) {
  return await Promise.all(docs.map(doc => populateDoc(model, doc, populate, transaction)));
};


/**
 * Populates all the requested relational field on the given document.
 */
export async function populateDoc<T extends object>(model: FirestoreConnectorModel<T>, doc: PartialSnapshot<T>, populate: AttributeKey<T>[], transaction: Transaction) {
  const values = doc.data();
  if (!values) {
    throw new StatusError(`Document not found: ${doc.ref.path}`, 404);
  }

  // Clone the object (shallow)
  const data = Object.assign({}, values);

  const relationPromises = Promise.all(populate.map(field => {
    const relation = model.relations.find(r => r.alias === field);
    return relation
      ? relation.populateRelated(doc.ref, data, transaction)
      : null;
  }));

  const componentPromises = Promise.all(model.componentKeys.map(async componentKey => {
    const component = _.get(data, componentKey);
    if (component) {
      // FIXME:
      // `ref` is pointing to the parent document that the component is embedded into
      // In the future, components embedding or not may be configurable
      // so we need a way to handle and differentiate this

      // FIXME:
      // The typeings were a bit hard to get working here so I ended up
      // casting them all as `any`

      if (Array.isArray(component)) {
        _.set(
          data, 
          componentKey, 
          await Promise.all((component as any[]).map(c => {
            const componentModel = getComponentModel(model, componentKey, c);
            return populateDoc(componentModel, { ref: doc.ref, data: () => c }, componentModel.defaultPopulate, transaction);
          })) as any
        );
      } else {
        const componentModel = getComponentModel(model, componentKey, component);
        _.set(
          data,
          componentKey,
          await populateDoc(componentModel, { ref: doc.ref, data: () => component }, componentModel.defaultPopulate, transaction) as any
        );
      }
    }
  }));

  await Promise.all([relationPromises, componentPromises]);

  return data;
}
