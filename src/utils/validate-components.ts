import * as _ from 'lodash';
import { FirestoreConnectorModel } from "../types";
import { StatusError } from "./status-error";

export interface Component {
  value: any
  model: FirestoreConnectorModel
}

export function validateComponents(values, model: FirestoreConnectorModel): Component[] {
  const components: any[] = [];
  for (const key of model.componentKeys) {
    const attr = model.attributes[key];
    const { type } = attr;

    if (type === 'component') {
      const { required = false, repeatable = false } = attr;
      if (required === true && !_.has(values, key)) {
        throw new StatusError(`Component ${key} is required`, 400);
      }

      if (!_.has(values, key)) continue;
      const componentValue = values[key];

      if (repeatable === true) {
        validateRepeatableInput(componentValue, { key, ...attr });
        components.push(...(componentValue as any[]));
      } else {
        validateNonRepeatableInput(componentValue, { key, ...attr });
        components.push(componentValue);
      }
      continue;
    }

    if (type === 'dynamiczone') {
      const { required = false } = attr;
      if (required === true && !_.has(values, key)) {
        throw new StatusError(`Dynamiczone ${key} is required`, 400);
      }

      if (!_.has(values, key)) continue;
      const dynamiczoneValues = values[key];

      validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });
      components.push(...(dynamiczoneValues as any[]));

      continue;
    }
  }

  return components.map(value => ({
    value,
    model: strapi.components[value.__component]
  }));
}


function validateRepeatableInput(value, { key, min, max, required }) {
  if (!Array.isArray(value)) {
    throw new StatusError(`Component ${key} is repetable. Expected an array`, 400);
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      throw new StatusError(`Component ${key} has invalid items. Expected each items to be objects`, 400);
    }
  });

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    throw new StatusError(`Component ${key} must contain at least ${min} items`, 400);
  }

  if (max && value.length > max) {
    throw new StatusError(`Component ${key} must contain at most ${max} items`, 400);
  }
}

function validateNonRepeatableInput(value, { key, required }) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StatusError(`Component ${key} should be an object`, 400);
  }

  if (required === true && value === null) {
    throw new StatusError(`Component ${key} is required`, 400);
  }
}

function validateDynamiczoneInput(value, { key, min, max, components, required }) {
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

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    throw new StatusError(`Dynamiczone ${key} must contain at least ${min} items`, 400);
  }
  if (max && value.length > max) {
    throw new StatusError(`Dynamiczone ${key} must contain at most ${max} items`, 400);
  }
}
