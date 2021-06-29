import * as _ from 'lodash';
import { getComponentModel } from './utils/components';
import type { Transaction } from './db/transaction';
import type { Reference, Snapshot } from './db/reference';
import { FirestoreConnectorModel } from './model';
import { StatusError } from './utils/status-error';

/**
 * Defines a type where all Reference members of T are populated as their referred types.
 */
export type Populated<T extends object> = {
  [Key in keyof T]: T[Key] extends Reference<infer R> ? R : T[Key];
}

/**
 * Picks the keys of T whose values are References.
 */
 export type PickReferenceKeys<T extends object> = Extract<{ [Key in keyof T]-?: T[Key] extends Reference<infer R> ? Key : never; }[keyof T], string>

/**
 * Defines a type where all Reference members amongst those with the given keys are
 * populated as their referred types.
 */
export type PopulatedKeys<T extends object, K extends PickReferenceKeys<T>> = Omit<T, K> & Populated<Pick<T, K>>


/**
 * Populates all the requested relational field on the given documents.
 */
export async function populateSnapshots<T extends object, K extends PickReferenceKeys<T>>(snaps: Snapshot<T>[], populate: K[], transaction: Transaction): Promise<PopulatedKeys<T, K>[]> {
  return await Promise.all(
    snaps.map(async snap => {
      const data = snap.data();
      if (!data) {
        throw new StatusError('entry.notFound', 404);
      }
      return await populateDoc<T, K>(snap.ref.parent.model, snap.ref, data, populate, transaction);
    })
  );
}

/**
 * Populates all the requested relational field on the given document.
 */
export async function populateDoc<T extends object, K extends PickReferenceKeys<T>>(model: FirestoreConnectorModel<T>, ref: Reference<T>, data: T, populateKeys: K[], transaction: Transaction): Promise<PopulatedKeys<T, K>> {
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

  // TODO: Better type safety
  return newData as any;
}
