import * as _ from 'lodash';
import { getComponentModel } from './utils/components';
import type { Transaction } from './db/transaction';
import type { AttributeKey } from './types';
import type { Reference, Snapshot } from './db/reference';
import { FirestoreConnectorModel } from './model';
import { StatusError } from './utils/status-error';

/**
 * Populates all the requested relational field on the given documents.
 */
export async function populateSnapshots<T extends object>(snaps: Snapshot<T>[], populate: AttributeKey<T>[], transaction: Transaction) {
  return await Promise.all(
    snaps.map(async snap => {
      const data = snap.data();
      if (!data) {
        throw new StatusError('entry.notFound', 404);
      }
      return await populateDoc(snap.ref.parent.model, snap.ref, data, populate, transaction);
    })
  );
}

/**
 * Populates all the requested relational field on the given document.
 */
export async function populateDoc<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference<T>, data: T, populateKeys: AttributeKey<T>[], transaction: Transaction): Promise<T> {
  const promises: Promise<any>[] = [];

  // Shallow copy the object
  const newData = Object.assign({}, data);

  // Populate own relations
  for (const key of populateKeys) {
    const relation = model.relations.find(r => r.alias === key);
    if (relation) {
      promises.push(relation.populateRelated(ref, newData, transaction));
    }
  }

  // Recursively populate components
  promises.push(
    ...model.componentKeys.map(async componentKey => {
      const component: any = _.get(newData, componentKey);
      if (component) {
        if (Array.isArray(component)) {
          const values = await Promise.all(
            component.map(c => {
              const componentModel = getComponentModel(model, componentKey, c);
              return populateDoc(componentModel, ref, c, componentModel.defaultPopulate, transaction);
            })
          );
          _.set(newData, componentKey, values);
        } else {
          const componentModel = getComponentModel(model, componentKey, component);
          const value = await populateDoc(componentModel, ref, component, componentModel.defaultPopulate, transaction);
          _.set(newData, componentKey, value);
        }
      }
    })
  );

  await Promise.all(promises);
  return newData
}
