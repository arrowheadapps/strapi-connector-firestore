import { DocumentData } from '@google-cloud/firestore';
import * as _ from 'lodash';
import type { FirestoreConnectorModel } from "../model";
import type { AttributeKey, StrapiAttribute } from "../types";
import { toFirestore } from './coerce';
import { StatusError } from "./status-error";

export interface Component<T extends object> {
  key: string
  value: any
  model: FirestoreConnectorModel<T>
}

export function getComponentModel<R extends object>(componentName: string): FirestoreConnectorModel<R>
export function getComponentModel<T extends object, R extends object = DocumentData>(hostModel: FirestoreConnectorModel<T>, key: AttributeKey<T>, value: T[AttributeKey<T>]): FirestoreConnectorModel<R>
export function getComponentModel<T extends object, R extends object = DocumentData>(hostModelOrName: FirestoreConnectorModel<T> | string, key?: AttributeKey<T>, value?: any): FirestoreConnectorModel<R> {
  const modelName = typeof hostModelOrName === 'string'
    ? hostModelOrName
    : value!.__component || hostModelOrName.attributes[key!].component;
  
  const model = strapi.components[modelName];
  if (!model) {
    throw new Error(`Cannot find model for component "${modelName}"`);
  }
  return model;
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
          const metaKey = typeof componentAttr.indexed === 'string'
            ? componentAttr.indexed
            : alias;
          const indexers = _.castArray((componentAttr.indexedBy || [(value) => [metaKey, value]]));
          const values = _.castArray(_.get(component, alias, []));
          values.forEach(v => {
            v = toFirestore(componentAttr, v);
            indexers.forEach(indexer => {
              const result = indexer(v, component);
              if (result) {
                const [key, value] = result;
                (meta[key] = meta[key] || []).push(value);
              }
            });
          });
          meta[alias].push(...values);
        });
      });

      _.set(output, metaField, meta);
    }
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
