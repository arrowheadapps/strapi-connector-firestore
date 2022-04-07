import * as _ from 'lodash';
import * as parseType from 'strapi-utils/lib/parse-type';
import { DocumentReference, FieldValue, Timestamp } from '@google-cloud/firestore';
import type { FirestoreConnectorModel } from '../model';
import { DeepReference } from '../db/deep-reference';
import { FlatReferenceShape, MorphReferenceShape, Reference } from '../db/reference';
import { StatusError } from '../utils/status-error';
import type { StrapiAttribute } from '../types';
import { getComponentModel } from '../utils/components';
import { MorphReference } from '../db/morph-reference';
import { updateComponentsMetadata } from '../utils/components-indexing';
import { NormalReference } from '../db/normal-reference';
import { FieldOperation } from '../db/field-operation';
import { VirtualReference } from '../db/virtual-reference';

export class CoercionError extends StatusError {
  constructor(message: string) {
    super(message, 400);
  }
}

export interface CoerceOpts {
  editMode?: 'create' | 'update'
  timestamp?: Date
}

/**
 * Attempts to coerce the data to the correct types based on the
 * given model schema, builds `Reference` instances for relations, and generates
 * index metadata for components.
 * 
 * Designed to both coerce from user input, or rehydrate from Firestore.
 */
export function coerceToModel<T extends object>(model: FirestoreConnectorModel<T>, id: string | undefined, data: unknown, fieldPath: string | null | undefined, opts: CoerceOpts): T {
  
  const obj = coerceModelRecursive(model, data, fieldPath, opts);

  // If fieldPath is provided then this is a partial update map
  // and this is not the root object
  if (!fieldPath) {

    // Set the document ID
    if (id) {
      _.set(obj, model.primaryKey, id);
    }

    // Assign timestamps
    if (model.timestamps && opts.editMode) {
      const now = opts.timestamp || new Date();
      const [createdAtKey, updatedAtKey] = model.timestamps;
      _.set(obj, updatedAtKey, now);
      if (opts.editMode === 'create') {
        _.set(obj, createdAtKey, now);
      } else {
        _.unset(obj, createdAtKey);
      }
    }

    // Generate metadata only for edits (to Firestore)
    if (opts.editMode) {
      updateComponentsMetadata(model, obj);
    }
  }

  return obj;
}


function fallbackCoerceOrCopy(value: any, opts: CoerceOpts & { ignoreMismatchedReferences: boolean }): any {
  const result = coerceAttrToModel(undefined, value, opts);
  if (result === value) {
    // If coercion returned the same object then we return undefined
    // to that cloneDeepWith handles the copying
    // We need this in order to copy root object etc
    return undefined;
  }
  return result;
}

function coerceModelRecursive<T extends object>(model: FirestoreConnectorModel<T>, data: unknown, parentPath: string | null | undefined, opts: CoerceOpts) {
  const options = { ...opts, ignoreMismatchedReferences: model.options.ignoreMismatchedReferences };
  return _.cloneDeepWith(data, (value, key) => {
    const path = [parentPath, key].filter(Boolean).join('.');
    if (!path) {
      // Root object, pass through
      // Perform basic coercion
      // E.g. this handles document-level FieldOperation.delete()
      // for flattened collections
      return fallbackCoerceOrCopy(value, options);
    }

    const attr = model.attributes[path];
    if (!attr && _.isPlainObject(value)) {
      if (key) {
        return coerceModelRecursive(model, value, path, opts);
      } else {
        // Stop infinite recursion
        // Perform basic coercion of necessary types
        return fallbackCoerceOrCopy(value, options);
      }
    }

    return coerceAttrToModel(attr, value, options);
  });
}


/**
 * Coerces a given attribute value to out of the value stored in Firestore to the
 * value expected by the given attribute schema.
 */
export function coerceAttrToModel(attr: StrapiAttribute | undefined, value: unknown, opts: CoerceOpts & { ignoreMismatchedReferences: boolean }): unknown {

  if (Array.isArray(value) && attr?.isMeta) {
    // Meta attributes are arrays, so we need to coerce the value recursively
    return value.map(v => coerceAttrToModel(attr, v, opts));
  }

  // Coerce values inside FieldOperation
  if (value instanceof FieldOperation) {
    return value.coerceWith(v => coerceAttrToModel(attr, v, opts));
  }

  // Cannot operate on FieldValue
  if (value instanceof FieldValue) {
    strapi.log.warn(
      'Cannot coerce instances of FieldValue, which may result in incorrect data types being ' +
      'written to Firestore. Recommend to use FieldOperation equivalent instead.'
    );
    return value;
  }

  // Firestore returns Timestamp for all Date values
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  // Restore number fields back
  // Because Firestore returns BigInt for all integer values
  // Do this by default for all BigInt unless the attribute is specifically a BigInt
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


  // Recursively coerce components
  // type == 'component'
  if (attr.component) {
    const componentModel = getComponentModel(attr.component);
    if (Array.isArray(value)) {
      // Generate ID if setting dictates
      return value.map(v => coerceToModel(componentModel, getIdOrAuto(componentModel, v), v, null, opts));
    } else {
      if (value) {
        if (typeof value !== 'object') {
          return fault(opts, 'Invalid value provided. Component must be an array or an object.');
        }
        // Generate ID if setting dictates
        return coerceToModel(componentModel, getIdOrAuto(componentModel, value), value!, null, opts);
      } else {
        return null;
      }
    }
  }

  // Recursively coerce dynamiczone
  // type == 'dynamiczone'
  if (attr.components) {
    if (Array.isArray(value)) {
      return value.map(v => {
        // Generate ID if setting dictates
        const componentModel = getComponentModel(v.__component);
        return coerceToModel(componentModel, getIdOrAuto(componentModel, v), v, null, opts);
      });
    } else {
      if (value) {
        if (typeof value !== 'object') {
          return fault(opts, 'Invalid value provided. Component must be an array or an object.');
        }
        // Generate ID if setting dictates
        const componentModel = getComponentModel((value as any).__component);
        return coerceToModel(componentModel, getIdOrAuto(componentModel, value), value!, null, opts);
      } else {
        return null;
      }
    }
  }

  if (attr.type) {
    const v = value;
    const err = () => fault(opts, `Invalid value provided. Could not coerce to type "${attr.type}" from value "${v}".`);

    switch (attr.type) {
      case 'integer':
      case 'float':
      case 'decimal':
        if (typeof value !== 'number') {
          value = Number(value);
          if (Number.isNaN(value)) {
            return err();
          }
        }
        break;

      case 'biginteger':
        if (typeof value !== 'bigint') {
          try {
            value = BigInt(value as any);
          } catch {
            return err();
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
          return err();
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

      // Convert DeepReference instances to a string value
      // that can be serialised to Firestore
      if (Array.isArray(value)) {
        value = value.map(v => {
          return coerceToReference(v, assocModel, opts);
        });
      } else {
        return coerceToReference(value, assocModel, opts);
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
function coerceToReference<T extends object = object>(value: any, to: FirestoreConnectorModel<T> | undefined, opts: CoerceOpts & { ignoreMismatchedReferences: boolean }): Reference<T> | null {
  if ((value === undefined) || (value === null)) {
    return null;
  }

  if (value instanceof Reference) {
    return value;
  }

  if (value instanceof DocumentReference) {
    // When deserialised from Firestore it comes without any converters
    // We want to get the appropriate converters so we reinstantiate it
    return reinstantiateReference(value, undefined, to, opts);
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
        return fault(opts, 'Malformed polymorphic reference: `id` must be a string');
      }
      id = obj.id;
    }

    const ref = reinstantiateReference(obj.ref, id, to, opts);
    if (!ref) {
      return ref;
    }
    
    if ('filter' in obj) {
      if ((obj.filter !== null) && (!obj.filter || (typeof obj.filter !== 'string'))) {
        return fault(opts, 'Malformed polymorphic reference: `filter` must be a string');
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
        return fault(opts, `The model "${targetModelName}" with plugin "${plugin}" in polymorphic relation could not be found`)
      }
      return new MorphReference(targetModel.db.doc(id), field);
    }
  }

  const path: string = (typeof value === 'string')
    ? value
    : (to ? to.getPK(value) : value.id);

  if (path && (typeof path === 'string')) {

    const lastSep = path.lastIndexOf('/');
    if (lastSep === -1) {
      // No path separators so it is just an ID
      if (to) {
        return to.db.doc(path);
      } else {
        return fault(opts, `Polymorphic reference must be fully qualified. Got the ID segment only.`);
      }
    }
    

    // TODO:
    // Remove this string parsing behaviour before stable release
    // DeepReference is no longer serialised to string
    // this is for alpha support only

    // It must be an absolute deep reference path
    // Verify that the path actually refers to the target model
    const id = path.slice(lastSep + 1);
    if (id) {
      if (to) {
        const deepRef = to.db.doc(id);
        if ((deepRef.path !== _.trim(path, '/')) && !opts.ignoreMismatchedReferences) {
          return fault(opts, `Reference is pointing to the wrong model. Expected "${deepRef.path}", got "${id}".`);
        }
        return deepRef;
      } else {
        const collection = _.trim(path.slice(0, lastSep), '/');
        const model = strapi.db.getModelByCollectionName(collection);
        if (!model) {
          return fault(opts, `The model referred to by "${collection}" doesn't exist`);
        }
        return model.db.doc(id);
      }
    }
  }

  return fault(opts, `Value could not be coerced to a reference: "${JSON.stringify(value)}"`);
}

/**
 * When deserialised from Firestore, references comes without any converters.
 * Re-instantiates the reference via the target model so that it comes
 * loaded with the appropriate converter.
 */
function reinstantiateReference<T extends object>(value: DocumentReference<T | { [id: string]: T }>, id: string | undefined, to: FirestoreConnectorModel<T> | undefined, opts: CoerceOpts & { ignoreMismatchedReferences: boolean }): NormalReference<T> | DeepReference<T> | VirtualReference<T> | null {
  if (to && !opts.ignoreMismatchedReferences) {
    const newRef = to.db.doc(id || value.id);
    if (newRef.parent.path !== value.parent.path) {
      return fault(opts, `Reference is pointing to the wrong model. Expected "${newRef.path}", got "${value.path}".`);
    }
    return newRef;
  } else {
    const model = strapi.db.getModelByCollectionName(value.parent.path);
    if (!model) {
      return fault(opts, `The model referred to by "${value.parent.path}" doesn't exist`);
    }
    return model.db.doc(value.id);
  }
}

function getIdOrAuto(model: FirestoreConnectorModel, value: any): string | undefined {
  if (model.options.ensureComponentIds) {
    // Ensure there is a guaranteed ID
    return _.get(value, model.primaryKey) || model.db.autoId();
  } else {
    // Don't delete it if it already exists
    return _.get(value, model.primaryKey);
  }
}

function fault({ editMode }: CoerceOpts, message: string): null {
  if (editMode) {
    throw new CoercionError(message);
  } else {
    strapi.log.warn(message);
    return null;
  }
}
