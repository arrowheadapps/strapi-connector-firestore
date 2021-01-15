import * as _ from 'lodash';
import * as parseType from 'strapi-utils/lib/parse-type';
import { DocumentReference, Timestamp } from '@google-cloud/firestore';
import { FirestoreConnectorModel } from '../model';
import { DeepReference } from '../utils/deep-reference';
import { FlatReferenceShape, MorphReferenceShape, Reference, ReferenceShape } from '../utils/queryable-collection';
import { StatusError } from '../utils/status-error';
import { StrapiAttribute } from '../types';
import { getComponentModel } from '../utils/components';
import { MorphReference } from '../utils/morph-reference';



export interface CoerceOpts {
  /**
   * If `true`, then coercion problems will throw and error.
   * Otherwise a warning may be logged and the problem will be
   * ignored if possible.
   */
  strict: boolean
}

/**
 * Attempts to coerce the data to the correct types based on the
 * given model schema, and builds `Reference` instances for relations.
 * 
 * Designed to both coerce from user input, or rehydrate from Firestore.
 */
export function coerceToModel<T extends object>(model: FirestoreConnectorModel<T>, id: string, data: unknown, fieldPath: string | null | undefined, opts: CoerceOpts): T {
  
  const obj = coerceModelRecursive(model, data, fieldPath);

  // Set the document ID
  // If fieldPath is provided then this is a partial update map
  if (!fieldPath) {
    obj[model.primaryKey] = id;
  }
  
  return obj;
}


function fallbackCoerceOrCopy(value: any): any {
  const result = coerceAttrToModel(undefined, value);
  if (result === value) {
    // If coercion returned the same object then we return undefined
    // to that cloneDeepWith handles the copying
    // We need this in order to copy root object etc
    return undefined;
  }
  return result;
}

function coerceModelRecursive<T extends object>(model: FirestoreConnectorModel<T>, data: unknown, parentPath: string | null | undefined) {
  return _.cloneDeepWith(data, (value, key) => {
    const path = [parentPath, key].filter(Boolean).join('.');
    if (!path) {
      // Root object, pass through
      // Perform basic coercion
      // E.g. this handles document-level FieldOperation.delete()
      // for flattened collections
      return fallbackCoerceOrCopy(value);
    }

    const attr = model.attributes[path];
    if (!attr && _.isPlainObject(value)) {
      if (key) {
        return coerceModelRecursive(model, value, path);
      } else {
        // Stop infinite recursion
        // Perform basic coercion of necessary types
        return fallbackCoerceOrCopy(value);
      }
    }

    return coerceAttrToModel(attr, value);
  });
}


function coerceAttribute(relation: StrapiAttribute | undefined, value: unknown) {
  if (Array.isArray(value)) {
    value = value.map(v => coerceAttrToModel(relation, v));
  } else {
    value = coerceAttrToModel(relation, value);
  }
  return value;
}



/**
 * Coerces a given attribute value to out of the value stored in Firestore to the
 * value expected by the given attribute schema.
 */
export function coerceAttrToModel(attr: StrapiAttribute | undefined, value: unknown): unknown {
  // Firestore returns Timestamp for all Date values
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  // Restore number fields back
  // Because Firestore returns BigInt for all integer values
  // Do this by default for all bigints unless the attribute is specifically a BigInt
  // BigInt fields will come out as native BigInt but will be serialised to JSON as a string
  if ((typeof value === 'bigint') && (!attr || (attr.type !== 'biginteger'))) {
    return Number(value);
  }
  
  // Don't coerce unknown fields further
  if (!attr) {
    return value;
  }

  // Allow null or undefined on any type
  if ((value === null) || (value === undefined)) {
    return value;
  }


  // FIXME: integrate component validation
  // Recursively coerce components
  // type == 'component'
  if (attr.component) {
    const componentModel = getComponentModel(attr.component);
    if (Array.isArray(value)) {
      // Generate ID if setting dictates
      return value.map(v => coerceToModel(componentModel, getIdOrAuto(componentModel, v), v, null));
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new StatusError('Invalid value provided. Component must be an array or an object.', 400);
        }
        // Generate ID if setting dictates
        return coerceToModel(componentModel, getIdOrAuto(componentModel, value), value!, null);
      } else {
        return null;
      }
    }
  }

  // FIXME: integrate component validation
  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (attr.components) {
    if (Array.isArray(value)) {
      return value.map(v => {
        // Generate ID if setting dictates
        const componentModel = getComponentModel(v.__component);
        return coerceToModel(componentModel, getIdOrAuto(componentModel, v), v, null);
      });
    } else {
      if (value) {
        if (typeof value !== 'object') {
          throw new StatusError('Invalid value provided. Component must be an array or an object.', 400);
        }
        // Generate ID if setting dictates
        const componentModel = getComponentModel((value as any).__component);
        return coerceToModel(componentModel, getIdOrAuto(componentModel, value), value!, null);
      } else {
        return null;
      }
    }
  }

  if (attr.type) {
    const v = value;
    const err = () => new Error(`Invalid value provided. Could not coerce to type "${attr.type}" from value "${v}".`);

    switch (attr.type) {
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
        value = parseType({ type: attr.type, value });
        break;

    }

  } else {

    // Convert reference ID to document reference if it is one
    const target = attr.model || attr.collection;
    if (target) {
      const assocModel = strapi.db.getModel(target, attr.plugin);
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
    // We want to get the appropriate converters so we reinstantiate it
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

function coerceToReferenceShape<T extends object>(ref: Reference<T>): ReferenceShape<T> {
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
  if (model.options.ensureComponentIds) {
    // Ensure there is a guaranteed ID
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
