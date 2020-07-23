import * as _ from 'lodash';
import { getModel, coerceToReference } from './doc-ref';
import type { FirestoreConnectorModel, StrapiRelation } from "../types";

export function coerceModel(model: FirestoreConnectorModel, values: any) {
  Object.keys(model.attributes).forEach(key => {
    values[key] = coerceAttribute(model.attributes[key], values[key]);
  });
  return values;
}

export function coerceValue(model: FirestoreConnectorModel, field: string, value: any) {
  return coerceAttribute(model.attributes[field], value);
}

export function coerceAttribute(relation: StrapiRelation, value: any) {
  if (_.isArray(value)) {
    value = value.map(v => coerceValueImpl(relation, v));
  } else {
    value = coerceValueImpl(relation, value);
  }
  return value;
}

function coerceValueImpl(relation: StrapiRelation, value: any): any {
  // Don't coerce unknown field
  if (!relation) {
    return value;
  }

  // Allow null or undefined on any type
  if ((value === null) || (value === undefined)) {
    return value;
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

      case 'date':
      case 'time':
      case 'datetime':
        // TODO:
        // To we need to coerce this to a Date object?
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
        if (typeof value !== 'boolean') {
          switch ((typeof value === 'string') && value.toLowerCase()) {
            case 'true':
              value = true;
            case 'false':
              value = false;
            default:
              throw err();
          }
        }
        break;

      default:
        // Unknown field, don't coerce
        break;

    }

  } else {

    // Convert reference ID to document reference if it is one
    if (relation.model || relation.collection) {
      const assocModel = getModel(relation.model || relation.collection, relation.plugin);
      if (assocModel) {
        value = coerceToReference(value, assocModel);
      }
    }
  }

  return value;
}
