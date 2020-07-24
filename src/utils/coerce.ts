import * as _ from 'lodash';
import { getModel, coerceToReference } from './doc-ref';
import type { FirestoreConnectorModel, StrapiRelation } from "../types";
import { parseType } from 'strapi-utils/lib/parse-type';
import { Timestamp } from '@google-cloud/firestore';
import { getComponentModel } from './validate-components';

export function coerceModel(model: FirestoreConnectorModel, values: any, coerceFn = toFirestore) {
  if (!model) {
    return values;
  }

  const result = {};
  Object.keys(model.attributes).forEach(key => {
    result[key] = coerceAttribute(model.attributes[key], values[key]);
  });
  return result;
}

export function coerceValue(model: FirestoreConnectorModel, field: string, value: any, coerceFn = toFirestore) {
  if (!model) {
    return value;
  }

  return coerceAttribute(model.attributes[field], value);
}

export function coerceAttribute(relation: StrapiRelation, value: any, coerceFn = toFirestore) {
  if (_.isArray(value)) {
    value = value.map(v => toFirestore(relation, v));
  } else {
    value = toFirestore(relation, value);
  }
  return value;
}

export function toFirestore(relation: Partial<StrapiRelation>, value: any): any {
  
  // Allow unknown field without coersion
  // Rely on controllers and lifecycles to enforce
  // any policies on sanitisation
  if (!relation) {
    return value;
  }

  // Allow null or undefined on any type
  if ((value === null) || (value === undefined)) {
    return value;
  }

  // Recursively coerce components
  // type == 'component'
  if (relation.component) {
    const componentModel = getComponentModel(relation.component);
    if (_.isArray(value)) {
      return value.map(v => coerceModel(componentModel, v, toFirestore));
    } else {
      return coerceModel(componentModel, value, toFirestore);
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (relation.components) {
    return _.castArray(value).forEach(v => {
      const componentModel = getComponentModel(v.__component);
      return coerceModel(componentModel, v, toFirestore);
    });
  }

  if (relation.type) {
    const v = value;
    const err = () => new Error(`Invalid value provided. Could not coerce to "${relation.type}" from "${v}".`);

    switch (relation.type) {
      case 'integer':
      case 'float':
      case 'decimal':
        if (typeof value !== 'number') {
          value = Number(value);
          if (Number.isNaN(value)) {
            throw err();
          }
        }
        break;

      case 'biginteger':
        if (typeof value !== 'bigint') {
          try {
            value = BigInt(value);
          } catch {
            throw err();
          }
        }
        break;

      case 'string':
      case 'text':
      case 'richtext':
      case 'email':
      case 'password':
      case 'enumeration':
      case 'uid':
        if (typeof value !== 'string') {
          value = value?.toString();
        }
        break;

      case 'json':
        try {
          value = typeof value === 'string'
            ? JSON.parse(value)
            : value;
        } catch {
          throw err();
        }
        break;

      case 'boolean':
      case 'date':
      case 'time':
      case 'datetime':
      case 'timestamp':
      default:
        // These types can be handled by built-in Strapi utils
        value = parseType(relation.type);
        break;

    }

  } else {

    // Convert reference ID to document reference if it is one
    const target = relation.model || relation.collection;
    if (target) {
      const assocModel = getModel(target, relation.plugin);
      if (assocModel) {
        value = coerceToReference(value, assocModel);
      }
    }
  }

  return value;
}

export function fromFirestore(relation: Partial<StrapiRelation>, value: any): any {
  // Don't coerce unknown field
  if (!relation) {
    return value;
  }

  // Allow null or undefined on any type
  if ((value === null) || (value === undefined)) {
    return value;
  }

  // Restore number fields back
  // Because Firestore returns BigInt for all integer values
  // BigInt fields will come out as native BigInt
  // but will be serialised to JSON as a string
  if ((typeof value === 'bigint') && (relation.type !== 'biginteger')) {
    return Number(value);
  }

  if ((typeof value !== 'string') && (relation.type === 'json')) {
    return JSON.stringify(value);
  }

    // Firestore returns Timestamp for all Date values
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  // References will come out as references unchanged
  // but will be serialised to JSON as path string value
  // Strings will come out as strings unchanged
  // Arrays will come out as arrays
  return value;
}
