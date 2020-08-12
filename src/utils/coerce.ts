import * as _ from 'lodash';
import type { FirestoreConnectorModel, StrapiRelation } from "../types";
import * as parseType from 'strapi-utils/lib/parse-type';
import { Timestamp, DocumentReference } from '@google-cloud/firestore';
import { getComponentModel } from './validate-components';
import { Reference } from './queryable-collection';
import { DeepReference } from './deep-reference';

export function coerceModel(model: FirestoreConnectorModel, values: any, coerceFn = toFirestore) {
  if (!model) {
    return values;
  }
  
  return coerceModelRecursive(model, values, null, coerceFn);
}

function coerceModelRecursive(model: FirestoreConnectorModel, values: any, parentPath: string | null, coerceFn = toFirestore) {
  return _.cloneDeepWith(values, (value, key) => {
    if (key === undefined) {
      // Root object, pass through
      return undefined;
    }

    const path = parentPath ? parentPath + '.' + key : key as string;
    const attr = model.attributes[path];

    if (!attr && _.isPlainObject(value)) {
      return coerceModelRecursive(model, value, path, coerceFn);
    }

    return coerceAttribute(attr, value, coerceFn);
  });
}

export function coerceValue(model: FirestoreConnectorModel, field: string, value: any, coerceFn = toFirestore) {
  if (!model) {
    return value;
  }

  return coerceAttribute(model.attributes[field], value, coerceFn);
}

export function coerceAttribute(relation: StrapiRelation, value: any, coerceFn = toFirestore) {
  if (_.isArray(value)) {
    value = value.map(v => coerceFn(relation, v));
  } else {
    value = coerceFn(relation, value);
  }
  return value;
}

export function toFirestore(relation: Partial<StrapiRelation>, value: any): any {
  
  if (value instanceof DeepReference) {
    return value.toFirestoreValue();
  }

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
    if (_.isArray(value)) {
      return value.map(v => {
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, v, toFirestore);
      });
    } else {
      const componentModel = getComponentModel(value.__component);
      return coerceModel(componentModel, value, toFirestore);
    }
  }

  if (relation.type) {
    const v = value;
    const err = () => new Error(`Invalid value provided. Could not coerce to type "${relation.type}" from value "${v}".`);

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
          value = ((typeof value === 'string') && value.startsWith('{'))
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
        value = parseType({ type: relation.type, value });
        break;

    }

  } else {

    // Convert reference ID to document reference if it is one
    const target = relation.model || relation.collection;
    if (target) {
      const assocModel = strapi.db.getModel(target, relation.plugin);
      if (assocModel) {
        value = coerceReference(value, assocModel);

        // Convert DeepReference instances to a string value
        // that can be serialised to Firestore
        if (_.isArray(value)) {
          value = value.map(v => {
            return v instanceof DeepReference ? v.toFirestoreValue() : v;
          });
        } else {
          value = value instanceof DeepReference ? value.toFirestoreValue(): value;
        }
      }
    }
  }

  return value;
}

export function fromFirestore(relation: Partial<StrapiRelation>, value: any): any {
  // Firestore returns Timestamp for all Date values
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  
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

  // Recursively coerce components
  // type == 'component'
  if (relation.component) {
    const componentModel = getComponentModel(relation.component);
    if (_.isArray(value)) {
      return value.map(v => coerceModel(componentModel, v, fromFirestore));
    } else {
      return coerceModel(componentModel, value, fromFirestore);
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (relation.components) {
    if (_.isArray(value)) {
      return value.map(v => {
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, v, fromFirestore);
      });
    } else {
      const componentModel = getComponentModel(value.__component);
      return coerceModel(componentModel, value, fromFirestore);
    }
  }

  // Reconstruct DeepReference instances from string
  if (relation.model || relation.collection) {
    const toRef = (v) => {
      if (v instanceof DocumentReference) {
        // No coersion needed
        return v;
      } else {
        // This must be a DeepReference
        return DeepReference.parse(v);
      }
    };
    if (_.isArray(value)) {
      value = value.map(toRef);
    } else {
      value = toRef(value);
    }
  }

  // References will come out as references unchanged
  // but will be serialised to JSON as path string value
  // Strings will come out as strings unchanged
  // Arrays will come out as arrays
  return value;
}


/**
 * Coerces a value to a `Reference` if it is one.
 */
export function coerceReference(value: any, to: FirestoreConnectorModel): Reference | Reference[] | null {
  if (_.isArray(value)) {
    return value.map(v => coerceToReferenceSingle(v, to)!).filter(Boolean);
  } else {
    return coerceToReferenceSingle(value, to);
  }
}

function coerceToReferenceSingle(value: any, to: FirestoreConnectorModel): Reference | null {
  if ((value === undefined) || (value === null)) {
    return value;
  }

  if (value instanceof DocumentReference) {
    return value;
  }
  if (value instanceof DeepReference) {
    return value;
  }

  const id = (typeof value === 'string') 
    ? value 
    : to.getPK(value);

  if (id) {
    const parts = id.split('/');
    if (parts.length === 1) {
      // No path separators so it is just an ID
      return to.doc(id);
    }

    // TODO:
    // Verify that the path actually refers to the target model
    return to.doc(parts[parts.length - 1]);
  }
  
  return null;
}
