import type { FirestoreConnectorModel } from "../model";
import type { AttributeKey } from "../types";

export interface Component<T extends object> {
  key: string
  value: any
  model: FirestoreConnectorModel<T>
}

export function getComponentModel<R extends object>(componentName: string): FirestoreConnectorModel<R>
export function getComponentModel<T extends object, R extends object = any>(hostModel: FirestoreConnectorModel<T>, key: AttributeKey<T>, value: T[AttributeKey<T>]): FirestoreConnectorModel<R>
export function getComponentModel<T extends object, R extends object = any>(hostModelOrName: FirestoreConnectorModel<T> | string, key?: AttributeKey<T>, value?: any): FirestoreConnectorModel<R> {
  const modelName = typeof hostModelOrName === 'string'
    ? hostModelOrName
    : value!.__component || hostModelOrName.attributes[key!].component;
  
  const model = strapi.components[modelName];
  if (!model) {
    throw new Error(`Cannot find model for component "${modelName}"`);
  }
  return model;
}
