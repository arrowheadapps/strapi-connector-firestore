import { DocumentData } from '@google-cloud/firestore';
import * as _ from 'lodash';
import type { FirestoreConnectorModel } from "../model";
import type { AttributeKey, StrapiAttribute, StrapiModel } from "../types";
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

export function componentMetaKey<T extends object>(model: StrapiModel<T>, key: AttributeKey<T>): string {
  // TODO
  // Allow customisation of the key for the metadata
  return`${key}$meta`;
}

export function updateComponentsMetadata<T extends object>(model: FirestoreConnectorModel<T>, data: T) {
  for (const key of model.componentKeys) {
    const attr = model.attributes[key];
    if ((attr.type === 'dynamiczone')
      || (attr.type === 'component' && attr.repeatable)) {
      // Array of components
      // Cannot be queryied in Firestore
      // So we need to maintain a map of metadata that we can query
      if (model.indexedAttributes.length) {
        const meta: any = {};
        const values: any[] = _.castArray(_.get(data, key) || []);
        model.indexedAttributes.forEach(alias => {
          // Make an array containing the value of this attribute
          // from all the components in the array
          // If the value itself is an array then is is concatenated/flattened
          meta[alias] = values.map(v => _.castArray(_.get(v, alias, []))).flat();
        });

        data[componentMetaKey(model, key)] = meta;
      }
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
