import type { Model, ModelData, AttributeKey } from 'strapi';

export interface Component<T extends ModelData> {
  key: string
  value: any
  model: Model<T>
}

export function getComponentModel<R extends ModelData>(componentName: string): Model<R>
export function getComponentModel<T extends ModelData>(hostModel: Model<T>, key: AttributeKey<T>, value: T[AttributeKey<T>]): Model
export function getComponentModel<T extends ModelData>(hostModelOrName: Model<T> | string, key?: AttributeKey<T>, value?: any): Model {
  const modelName = typeof hostModelOrName === 'string'
    ? hostModelOrName
    : value!.__component || hostModelOrName.attributes[key!].component;
  
  const model = strapi.components[modelName];
  if (!model) {
    throw new Error(`Cannot find model for component "${modelName}"`);
  }
  return model;
}
