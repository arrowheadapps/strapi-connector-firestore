import * as _ from 'lodash';
import type { FirestoreConnectorModel } from '../model';
import type { StrapiAttribute } from '../types';
import * as parseType from 'strapi-utils/lib/parse-type';
import { Timestamp, DocumentReference, DocumentData, FieldValue } from '@google-cloud/firestore';
import { getComponentModel } from './components';
import { FlatReferenceShape, MorphReferenceShape, Reference, ReferenceShape } from './queryable-collection';
import { DeepReference } from './deep-reference';
import { MorphReference } from './morph-reference';
import { StatusError } from './status-error';

export interface CoerceFn {
  (relation: Partial<StrapiAttribute> | undefined, value: unknown): unknown
}


/**
 * Coerces an entire document to Firestore based on the model schema.
 */
export function coerceModelToFirestore<T extends object>(model: FirestoreConnectorModel<T>, values: DocumentData, fieldPath?: string): Partial<T> {
  return coerceModel(model, undefined, values, fieldPath, toFirestore) as Partial<T>;
}

/**
 * Coerces an entire document from Firestore based on the model schema.
 */
export function coerceModelFromFirestore<T extends object>(model: FirestoreConnectorModel<T>, docId: string, values: DocumentData, fieldPath?: string): T {
  return coerceModel(model, docId, values, fieldPath, fromFirestore) as T;
}


/**
 * Coerces an entire document based on the model schema.
 * @param model The model schema.
 * @param docId If provided, then it is assigned to the object's `primaryKey`, otherwise any `primaryKey` is deleted.
 * @param values The document data.
 * @param coerceFn The coerce function `toFirestore` or `fromFirestore` depending
 * on which direction the document should be coerced.
 */
function coerceModel<T extends object>(model: FirestoreConnectorModel<T>, docId: string | undefined, values: DocumentData, fieldPath: string | undefined, coerceFn: CoerceFn): any {
  if (!model) {
    return values;
  }
  
  const root = coerceModelRecursive(model, values, fieldPath || null, coerceFn);
  if (docId) {
    // From Firestore we don't get partial updates
    // with dot paths
    if (!fieldPath) {
      root[model.primaryKey] = docId;
    }
  } else {
    // To Firestore we need to handle partial updates
    // with dot paths
    if (fieldPath === model.primaryKey) {
      return undefined;
    } else if (!fieldPath) {
      delete root[model.primaryKey];
    }
  }
  return root;
}

function coerceModelRecursive<T extends object>(model: FirestoreConnectorModel<T>, values: DocumentData, parentPath: string | null, coerceFn: CoerceFn) {
  return _.cloneDeepWith(values, (value, key) => {
    const path = [parentPath, key].filter(Boolean).join('.');
    if (!path) {
      // Root object, pass through
      return undefined;
    }

    const attr = model.attributes[path];
    if (!attr && _.isPlainObject(value)) {
      if (key) {
        return coerceModelRecursive(model, value, path, coerceFn);
      } else {
        // Stop infinite recursion
        return undefined;
      }
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

export function coerceAttribute(relation: StrapiAttribute | undefined, value: unknown, coerceFn: CoerceFn) {
  if (Array.isArray(value)) {
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
export function toFirestore(relation: Partial<StrapiAttribute> | undefined, value: unknown): unknown {
  
  if (value instanceof FieldValue) {
    // Do not coerce `FieldValue`
    return value;
  }

  if ((value instanceof DeepReference) || (value instanceof MorphReference)) {
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
    if (Array.isArray(value)) {
      // Generate ID if setting dictates
      return value.map(v => coerceModel(componentModel, getIdOrAuto(componentModel, v), v, undefined, toFirestore));
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new StatusError('Invalid value provided. Component must be an array or an object.', 400);
        }
        // Generate ID if setting dictates
        return coerceModel(componentModel, getIdOrAuto(componentModel, value), value!, undefined, toFirestore);
      } else {
        return null;
      }
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (relation.components) {
    if (Array.isArray(value)) {
      return value.map(v => {
        // Generate ID if setting dictates
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, getIdOrAuto(componentModel, v), v, undefined, toFirestore);
      });
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new StatusError('Invalid value provided. Component must be an array or an object.', 400);
        }
        // Generate ID if setting dictates
        const componentModel = getComponentModel((value as any).__component);
        return coerceModel(componentModel, getIdOrAuto(componentModel, value), value!, undefined, toFirestore);
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
        // Convert DeepReference instances to a string value
        // that can be serialised to Firestore
        if (Array.isArray(value)) {
          value = value.map(v => {
            const ref = coerceToReference(v, assocModel, false);
            return ref && coerceToReferenceShape(ref);
          });
        } else {
          const ref = coerceToReference(value, assocModel, false);
          value = ref && coerceToReferenceShape(ref);
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
export function fromFirestore(relation: Partial<StrapiAttribute> | undefined, value: unknown): unknown {
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
    if (Array.isArray(value)) {
      // Keep primary key coming out of Firestore if it exists
      return value.map(v => coerceModel(componentModel, v[componentModel.primaryKey], v, undefined, fromFirestore));
    } else {
      if (value) {
        if (typeof value === 'object') {
          // Keep primary key coming out of Firestore if it exists
          return coerceModel(componentModel, value![componentModel.primaryKey], value!, undefined, fromFirestore);
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
    if (Array.isArray(value)) {
      return value.map(v => {
        // Keep primary key coming out of Firestore if it exists
        const componentModel = getComponentModel(v.__component);
        return coerceModel(componentModel, v[componentModel.primaryKey], v, undefined, fromFirestore);
      });
    } else {
      if (value) {
        if (typeof value === 'object') {
          // Keep primary key coming out of Firestore if it exists
          const componentModel = getComponentModel((value as any).__component);
          return coerceModel(componentModel, value![componentModel.primaryKey], value!, undefined, fromFirestore);
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
  const target = relation.model || relation.collection;
  if (target) {
    const assocModel = strapi.db.getModel(target, relation.plugin);
    if (Array.isArray(value)) {
      value = value.map(v => coerceToReference(v, assocModel, false));
    } else {
      value = coerceToReference(value, assocModel, false);
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
export function coerceToReference<T extends object = object>(value: any, to: FirestoreConnectorModel<T> | undefined, strict = false): Reference<T> | null {
  if ((value === undefined) || (value === null)) {
    return null;
  }

  if (value instanceof DocumentReference) {
    // When deserialised from Firestore it comes without any converters
    // We want to get the appropraite converters so we reinstantiate it
    return reinstantiateReference(value, undefined, to, strict);
  }

  if ((value instanceof DeepReference) || (value instanceof MorphReference)) {
    // DeepReference and DeepReference are not native to Firestore
    // to it has already been instantiated with 
    // the appropriate converters
    return value;
  }

  if ((typeof value === 'object')
    && ('ref' in value) 
    && (value.ref instanceof DocumentReference)) {
    // Coerce from ReferenceShape
    // i.e. the Firestore representation of DeepReference and MorphReference

    const obj: FlatReferenceShape<T> | MorphReferenceShape<T> = value;
    let id: string | undefined
    if ('id' in obj) {
      if (!obj.id || (typeof obj.id !== 'string')) {
        return fault(strict, 'Malformed polymorphic reference: `id` must be a string');
      }
      id = obj.id;
    }

    const ref = reinstantiateReference(obj.ref, id, to, strict);
    if (!ref) {
      return ref;
    }
    
    if ('filter' in obj) {
      if ((obj.filter !== null) && (!obj.filter || (typeof obj.filter !== 'string'))) {
        return fault(strict, 'Malformed polymorphic reference: `filter` must be a string');
      }
      return new MorphReference(ref, obj.filter);
    } else {
      return ref;
    }
  }

  if (typeof value === 'object') {
    // Coerce from the incoming Strapi API representation of
    // morph references
    // This isn't really documented
    const {
      ref: targetModelName,
      source: plugin,
      refId: id,
      field,
    } = value;
    if ((typeof targetModelName === 'string') 
      && (typeof id === 'string')
      && (!plugin || (typeof plugin === 'string'))
      && (!field || (typeof field === 'string'))) {
      const targetModel = strapi.db.getModel(targetModelName, plugin);
      if (!targetModel) {
        return fault(strict, `The model "${targetModelName}" with plugin "${plugin}" in polymorphic relation could not be found`)
      }
      return new MorphReference(targetModel.db.doc(id), field);
    }
  }

  if (typeof value === 'string') {

    const lastSep = value.lastIndexOf('/');
    if (lastSep === -1) {
      // No path separators so it is just an ID
      if (to) {
        return to.db.doc(value);
      } else {
        return fault(strict, `Polymorphic reference must be fully qualified. Got the ID segment only.`);
      }
    }
    

    // TODO:
    // Remove this string parsing behaviour before stable release
    // DeepReference is no longer serialised to string
    // this is for alpha support only

    // It must be an absolute deep reference path
    // Verify that the path actually refers to the target model
    const id = value.slice(lastSep + 1);
    if (id) {
      if (to) {
        const deepRef = to.db.doc(id);
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
        return model.db.doc(id);
      }
    }
  }

  return fault(strict, `Value could not be coerced to a reference: "${JSON.stringify(value)}"`);
}

export function coerceToReferenceShape<T extends object>(ref: Reference<T>): ReferenceShape<T> {
  return ('toFirestoreValue' in ref)
    ? ref.toFirestoreValue()
    : ref;
}

/**
 * When deserialised from Firestore, references comes without any converters.
 * Reinstantiates the reference via the target model so that it comes
 * loaded with the appropriate converter.
 */
function reinstantiateReference<T extends object>(value: DocumentReference<T | { [id: string]: T }>, id: string | undefined, to: FirestoreConnectorModel<T> | undefined, strict: boolean): DocumentReference<T> | DeepReference<T> | null {
  if (to) {
    const newRef = to.db.doc(id || value.id);
    if (newRef.parent.path !== value.parent.path) {
      return fault(strict, `Reference is pointing to the wrong model. Expected "${newRef.path}", got "${value.path}".`);
    }
    return newRef;
  } else {
    const model = strapi.db.getModelByCollectionName(value.parent.path);
    if (!model) {
      return fault(strict, `The model referred to by "${value.parent.path}" doesn't exist`);
    }
    return model.db.doc(value.id);
  }
}

function getIdOrAuto(model: FirestoreConnectorModel, value: any): string | undefined {
  if (model.options.ensureCompnentIds) {
    // Ensure there is a gauranteed ID
    return value[model.primaryKey] || model.db.autoId();
  } else {
    // Don't delete it if it already exists
    return value[model.primaryKey];
  }
}

function fault(strict: boolean | undefined, message: string): null {
  if (strict) {
    throw new StatusError(message, 400);
  } else {
    strapi.log.warn(message);
    return null;
  }
};
