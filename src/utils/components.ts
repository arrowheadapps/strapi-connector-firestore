import * as _ from 'lodash';
import type { FirestoreConnectorModel } from "../model";
import type { AttributeKey, IndexerFn, StrapiAttribute } from "../types";
import { toFirestore } from './coerce';
import { isEqualHandlingRef } from './queryable-collection';
import { StatusError } from "./status-error";

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

export function componentRequiresMetadata(attr: StrapiAttribute): boolean {
  return attr.repeatable || Boolean(attr.components);
}

export function updateComponentsMetadata<T extends object>(model: FirestoreConnectorModel<T>, data: T, output: T = data) {
  for (const key of model.componentKeys) {
    const attr = model.attributes[key];
    if ((attr.type === 'dynamiczone')
      || (attr.type === 'component' && attr.repeatable)) {
      const metaField = model.getMetadataField(key);

      // Array of components cannot be queryied in Firestore
      // So we need to maintain a map of metadata that we can query
      const meta: any = Object.assign({}, _.get(data, metaField))
      const components: any[] = _.castArray(_.get(data, key) || []);

      // Make an array containing the value of this attribute
      // from all the components in the array
      // If the value itself is an array then is is concatenated/flattened
      components.forEach(component => {
        const componentModel = getComponentModel(model, key, component);
        componentModel.indexedAttributes.forEach(alias => {
          const componentAttr = componentModel.attributes[alias];
          const values = _.castArray(_.get(component, alias, []));
          const { indexers } = makeIndexerInfo(alias, componentAttr);
          values.forEach(v => {
            v = toFirestore(componentAttr, v);
            indexers.forEach(indexer => {
              const result = indexer(v, component);
              if (result) {
                if (!Array.isArray(result) || (result.length !== 2)) {
                  throw new Error(`Function in "indexedBy" for attribute ${alias} must return a tuple.`);
                }
                const [key, value] = result;
                const arr: any[] = meta[key] = meta[key] || [];
                // Only add if the element doesnt already exist
                if (!arr.some(v => isEqualHandlingRef(v, value))) {
                  arr.push(value);
                }
              }
            });
          });
        });
      });

      _.set(output, metaField, meta);
    }
  }
}

function makeIndexerInfo(alias: string, attr: StrapiAttribute): { metaKey: string, indexers: IndexerFn[] } {
  const metaKey = typeof attr.indexed === 'string' ? attr.indexed : alias;
  const defaultIndexer: IndexerFn = (value) => [metaKey, value];
  if (attr.indexedBy) {
    if (attr.model || attr.collection) {
      // Force a default indexer on relations because we rely on
      // it for reverse lookup of relations
      return {
        metaKey,
        indexers: [defaultIndexer, ..._.castArray(attr.indexedBy)],
      };
    } else {
      // For normal attributes `indexedBy` overrides `indexed`
      return {
        metaKey,
        indexers: _.castArray(attr.indexedBy),
      };
    }
  } else {
    return {
      metaKey,
      indexers: [defaultIndexer],
    };
  }
}

export function validateComponents<T extends object>(model: FirestoreConnectorModel<T>, values: T): Component<T>[] {
  const components: { value: T[AttributeKey<T>], key: AttributeKey<T> }[] = [];
  for (const key of model.componentKeys) {
    const attr = model.attributes[key];
    const { type } = attr;

    if (type === 'component') {
      const { required, repeatable } = attr;
      if (required && !_.has(values, key)) {
        throw new StatusError(`Component ${key} is required`, 400);
      }

      if (!_.has(values, key)) continue;
      const componentValue = _.get(values, key);

      if (repeatable) {
        validateRepeatableInput(componentValue, { key, ...attr });
        components.push(..._.castArray(componentValue).map(value => ({ value, key })));
      } else {
        validateNonRepeatableInput(componentValue, { key, ...attr });
        components.push({ value: componentValue, key });
      }
      continue;
    }

    if (type === 'dynamiczone') {
      const { required = false } = attr;
      if (required === true && !_.has(values, key)) {
        throw new StatusError(`Dynamiczone ${key} is required`, 400);
      }

      if (!_.has(values, key)) continue;
      const dynamiczoneValues = _.get(values, key);

      validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });
      components.push(..._.castArray(dynamiczoneValues).map(value => ({ value, key })));

      continue;
    }
  }

  return components.map(c => ({
    ...c,
    model: getComponentModel(model, c.key, c.value),
  }));
}


function validateRepeatableInput(value, { key, min, max, required }: { key } & StrapiAttribute) {
  if (!Array.isArray(value)) {
    throw new StatusError(`Component ${key} is repetable. Expected an array`, 400);
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      throw new StatusError(`Component ${key} has invalid items. Expected each items to be objects`, 400);
    }
  });

  if ((required === true || (value.length > 0)) && min && value.length < min) {
    throw new StatusError(`Component ${key} must contain at least ${min} items`, 400);
  }

  if (max && value.length > max) {
    throw new StatusError(`Component ${key} must contain at most ${max} items`, 400);
  }
}

function validateNonRepeatableInput(value, { key, required }: { key } & StrapiAttribute) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StatusError(`Component ${key} should be an object`, 400);
  }

  if (required === true && value === null) {
    throw new StatusError(`Component ${key} is required`, 400);
  }
}

function validateDynamiczoneInput(value, { key, min, max, components = [], required }: { key } & StrapiAttribute) {
  if (!Array.isArray(value)) {
    throw new StatusError(`Dynamiczone ${key} is invalid. Expected an array`, 400);
  }
  

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      throw new StatusError(`Dynamiczone ${key} has invalid items. Expected each items to be objects`, 400);
    }

    if (!_.has(val, '__component')) {
      throw new StatusError(`Dynamiczone ${key} has invalid items. Expected each items to have a valid __component key`, 400);
    } else if (!components.includes(val.__component)) {
      throw new StatusError(`Dynamiczone ${key} has invalid items. Each item must have a __component key that is present in the attribute definition`, 400);
    }
  });

  if ((required === true || (value.length > 0)) && min && value.length < min) {
    throw new StatusError(`Dynamiczone ${key} must contain at least ${min} items`, 400);
  }
  if (max && value.length > max) {
    throw new StatusError(`Dynamiczone ${key} must contain at most ${max} items`, 400);
  }
}
