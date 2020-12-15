import * as _ from 'lodash';
import type { FirestoreConnectorModel, StrapiRelation } from "../types";
import * as parseType from 'strapi-utils/lib/parse-type';
import { Timestamp, DocumentReference, DocumentData } from '@google-cloud/firestore';
import { getComponentModel } from './validate-components';
import { Reference } from './queryable-collection';
import { DeepReference } from './deep-reference';

export interface CoerceFn {
  (relation: Partial<StrapiRelation> | undefined, value: unknown): unknown
}


/**
 * Coerces an entire document to Firestore based on the model schema.
 */
export function coerceModelToFirestore(model: FirestoreConnectorModel, values: DocumentData): DocumentData {
  return coerceModel(model, undefined, values, toFirestore);
}

/**
 * Coerces an entire document from Firestore based on the model schema.
 */
export function coerceModelFromFirestore(model: FirestoreConnectorModel, docId: string, values: DocumentData): DocumentData {
  return coerceModel(model, docId, values, fromFirestore);
}


/**
 * Coerces an entire document based on the model schema.
 * @param model The model schema.
 * @param docId If provided, then it is assigned to the object's `primaryKey`, otherwise any `primaryKey` is deleted.
 * @param values The document data.
 * @param coerceFn The coerce function `toFirestore` or `fromFirestore` depending
 * on which direction the document should be coerced.
 */
function coerceModel(model: FirestoreConnectorModel, docId: string | undefined, values: DocumentData, coerceFn: CoerceFn): DocumentData {
  if (!model || !values) {
    return values;
  }
  
  const root = coerceModelRecursive(model, values, null, coerceFn);
  if (docId) {
    root[model.primaryKey] = docId;
  } else {
    delete root[model.primaryKey];
  }
  return root;
}

function coerceModelRecursive(model: FirestoreConnectorModel, values: DocumentData, parentPath: string | null, coerceFn: CoerceFn) {
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

export function coerceValue(model: FirestoreConnectorModel, field: string, value: unknown, coerceFn: CoerceFn) {
  if (!model) {
    return value;
  }

  return coerceAttribute(model.attributes[field], value, coerceFn);
}

export function coerceAttribute(relation: StrapiRelation | undefined, value: unknown, coerceFn: CoerceFn) {
  if (_.isArray(value)) {
    value = value.map(v => coerceFn(relation, v));
  } else {
    value = coerceFn(relation, value);
  }
  return value;
}

/**
 * Coerces a given attribute value to the correct data type for storage in Firestore
 * based on the given attribute schema.
 * 
 * **Note:**
 * This will automatically generate IDs for embedded components if they don't already have IDs.
 */
export function toFirestore(relation: Partial<StrapiRelation> | undefined, value: unknown): unknown {
  
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
      // Generate ID if setting dictates
      return value.map(v => coerceModel(componentModel, getIdOrAuto(componentModel, v), v, toFirestore));
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new Error('Invalid value provided. Component must be an array or an object.');
        }
        // Generate ID if setting dictates
        return coerceModel(componentModel, getIdOrAuto(componentModel, value), value!, toFirestore);
      } else {
        return null;
      }
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (relation.components) {
    if (_.isArray(value)) {
      return value.map(v => {
        // Generate ID if setting dictates
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, getIdOrAuto(componentModel, v), v, toFirestore);
      });
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new Error('Invalid value provided. Component must be an array or an object.');
        }
        // Generate ID if setting dictates
        const componentModel = getComponentModel((value as any).__component);
        return coerceModel(componentModel, getIdOrAuto(componentModel, value), value!, toFirestore);
      } else {
        return null;
      }
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
          value = (value as any)?.toString();
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

/**
 * Coerces a given attribute value to out of the value stored in Firestore to the
 * value expected by the given attribute schema.
 */
export function fromFirestore(relation: Partial<StrapiRelation> | undefined, value: unknown): unknown {
  // Firestore returns Timestamp for all Date values
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  // Restore number fields back
  // Because Firestore returns BigInt for all integer values
  // Do this by default for all bigints unless the attribute is specifically a BigInt
  // BigInt fields will come out as native BigInt but will be serialised to JSON as a string
  if ((typeof value === 'bigint') && (relation?.type !== 'biginteger')) {
    return Number(value);
  }

  
  // Don't coerce unknown fields further
  if (!relation) {
    return value;
  }

  // Allow null or undefined on any type
  if ((value === null) || (value === undefined)) {
    return value;
  }

  if ((typeof value !== 'string') && (relation.type === 'json')) {
    return JSON.stringify(value);
  }

  // Recursively coerce components
  // type == 'component'
  if (relation.component) {
    const componentModel = getComponentModel(relation.component);
    if (_.isArray(value)) {
      // Keep primary key coming out of Firestore if it exists
      return value.map(v => coerceModel(componentModel, v[componentModel.primaryKey], v, fromFirestore));
    } else {
      if (value) {
        if (typeof value === 'object') {
          // Keep primary key coming out of Firestore if it exists
          return coerceModel(componentModel, value![componentModel.primaryKey], value!, fromFirestore);
        } else {
          strapi.log.warn(`Invalid value in place of component "${relation.component}"`);
          return null;
        }
      } else {
        return null;
      }
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (relation.components) {
    if (_.isArray(value)) {
      return value.map(v => {
        // Keep primary key coming out of Firestore if it exists
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, v[componentModel.primaryKey], v, fromFirestore);
      });
    } else {
      if (value) {
        if (typeof value === 'object') {
          // Keep primary key coming out of Firestore if it exists
          const componentModel = getComponentModel((value as any).__component);
          return coerceModel(componentModel, value![componentModel.primaryKey], value!, fromFirestore);
        } else {
          strapi.log.warn(`Invalid value in place of components ${JSON.stringify(relation.components)}`);
          return null;
        }
      } else {
        return null;
      }
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
export function coerceReference(value: any, to: FirestoreConnectorModel | undefined, strict?: boolean): Reference | Reference[] | null {
  if (_.isArray(value)) {
    return value.map(v => coerceToReferenceSingle(v, to, strict)!).filter(Boolean);
  } else {
    return coerceToReferenceSingle(value, to, strict);
  }
}

export function coerceToReferenceSingle(value: any, to: FirestoreConnectorModel | undefined, strict?: boolean): Reference | null {
  if ((value === undefined) || (value === null)) {
    return null;
  }

  if (value instanceof DocumentReference) {
    // When deserialised from Firestore it comes without any converters
    // We want to get the appropraite converters so we reinstantiate it
    if (to) {
      const newRef = to.doc(value.id);
      if (newRef.path !== value.path) {
        return fault(strict, `Reference is pointing to the wrong model. Expected "${newRef.path}", got "${value.path}".`);
      }
      return newRef;
    } else {
      const model = strapi.db.getModelByCollectionName(value.parent.path);
      if (!model) {
        return fault(strict, `The model referred to by "${value.parent.path}" doesn't exist`);
      }
      return model.doc(value.id);
    }
  }
  if (value instanceof DeepReference) {
    // DeepReference is not native to Firestore
    // to it has already been instantiated with 
    // the appropriate converters
    return value;
  }

  if (typeof value === 'string') {
    const lastSep = value.lastIndexOf('/');
    if (lastSep === -1) {
      // No path separators so it is just an ID
      if (to) {
        return to.doc(value);
      } else {
        return fault(strict, `Polymorphic reference must be fully qualified. Got the ID segment only.`);
      }
    }

    // It must be an absolute deep reference path
    // Verify that the path actually refers to the target model
    const id = value.slice(lastSep + 1);
    if (id) {
      if (to) {
        const deepRef = to.doc(id);
        if (deepRef.path !== value) {
          return fault(strict, `Reference is pointing to the wrong model. Expected "${deepRef.path}", got "${id}".`);
        }
        return deepRef;
      } else {
        const collection = _.trim(value.slice(0, lastSep), '/');
        const model = strapi.db.getModelByCollectionName(collection);
        if (!model) {
          return fault(strict, `The model referred to by "${collection}" doesn't exist`);
        }
        return model.doc(id);
      }
    }
  }

  return fault(strict, `Value could not be coerced to a reference: "${JSON.stringify(value)}"`);
}

function getIdOrAuto(model: FirestoreConnectorModel, value: any): string | undefined {
  if (model.options.ensureCompnentIds) {
    // Ensure there is a gauranteed ID
    return value[model.primaryKey] || model.autoId();
  } else {
    // Don't delete it if it already exists
    return value[model.primaryKey];
  }
}

function fault(strict: boolean | undefined, message: string): null {
  if (strict) {
    throw new Error(message);
  } else {
    strapi.log.warn(message);
    return null;
  }
};