import * as _ from 'lodash';
import { WhereFilterOp, FieldPath } from '@google-cloud/firestore';
import type { StrapiAttribute, StrapiWhereOperator } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { coerceAttrToModel } from '../coerce/coerce-to-model';
import { isEqualHandlingRef, Snapshot } from '../db/reference';
import { StatusError } from './status-error';

const FIRESTORE_MAX_ARRAY_ELEMENTS = 10;

export class EmptyQueryError extends Error {
  constructor() {
    super('Query parameters will result in empty response');
  }
}

export type PartialSnapshot<T extends object> =
  Pick<Snapshot<T>, 'data'> &
  Pick<Snapshot<T>, 'id'>;

export interface ManualFilter {
  (data: PartialSnapshot<any>): boolean
}

export interface WhereFilter {
  field: string | FieldPath
  operator: WhereFilterOp
  value: any
}

export function fieldPathToPath(model: FirestoreConnectorModel<any>, field: string | FieldPath): string {
  if (field instanceof FieldPath) {
    const path = field.toString();
    if (path === FieldPath.documentId().toString()) {
      return model.primaryKey;
    }
    return path;
  }
  return field;
}

export function getAtPath(model: FirestoreConnectorModel<any>, path: string, data: PartialSnapshot<any>): any {
  if (path === model.primaryKey) {
    return data.id;
  }
  return _.get(data.data(), path, undefined);
}

export function getAtFieldPath(model: FirestoreConnectorModel<any>, path: string | FieldPath, data: Snapshot<any>): any {
  return getAtPath(model, fieldPathToPath(model, path), data);
}


/**
 * Convert a Strapi or Firestore query operator to a Firestore operator
 * or a manual function.
 */
export function convertWhere(model: FirestoreConnectorModel<any>, field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any, mode: 'manualOnly'): ManualFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any, mode: 'nativeOnly'): WhereFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): WhereFilter | ManualFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): WhereFilter | ManualFilter | null {
  
  let op: WhereFilterOp | ((filterValue: any, fieldValue: any) => boolean);
  switch (operator) {
    case '==':
    case 'eq':
      if (Array.isArray(value)) {
        // Equals any (OR)
        // I.e. "in"
        return convertWhere(model, field, 'in', value, mode);
      } else {
        // Equals
        op = '==';
        break;
      }

    case '!=':
    case 'ne':
      if (Array.isArray(value)) {
        // Not equals any (OR)
        // I.e. "nin"
        return convertWhere(model, field, 'nin', value, mode);
      } else {
        // Not equal
        op = '!=';
        break;
      }

    case 'in':
      // Included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      if ((value as any[]).length === 0) {
        throw new EmptyQueryError();
      }
      op = ((value as any[]).length > FIRESTORE_MAX_ARRAY_ELEMENTS) 
        ? fsOps.in 
        : 'in';
      break;

    case 'not-in':
    case 'nin':
      // Not included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      if ((value as any[]).length === 0) {
        return null;
      }
      op = ((value as any[]).length > FIRESTORE_MAX_ARRAY_ELEMENTS)
        ? fsOps['not-in'] 
        : 'not-in';
      break;

    case 'contains':
      // NO NATIVE SUPPORT
      // String includes value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = contains;
      break;

    case 'ncontains':
      // NO NATIVE SUPPORT
      // String doesn't value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = ncontains;
      break;

    case 'containss':
      // NO NATIVE SUPPORT
      // String includes value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = containss;
      break;

    case 'ncontainss':
      // NO NATIVE SUPPORT
      // String doesn't include value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = ncontainss;
      break;

    case '<':
    case 'lt':
      if (Array.isArray(value)) {
        // Less than any (OR)
        // Just take the maximum
        value = _.max(value);
      }
      // Less than
      op = '<';
      break;

    case '<=':
    case 'lte':
      if (Array.isArray(value)) {
        // Less than any (OR)
        // Just take the maximum
        value = _.max(value);
      }
      // Less than or equal
      op = '<=';
      break;

    case '>':
    case 'gt':
      if (Array.isArray(value)) {
        // Greater than any (OR)
        // Just take the minimum
        value = _.min(value);
      }
      // Greater than
      op = '>';
      break;

    case '>=':
    case 'gte':
      if (Array.isArray(value)) {
        // Greater than any (OR)
        // Just take the minimum
        value = _.min(value);
      }
      // Greater than or equal
      op = '>=';
      break;

    case 'null':
      if (_.toLower(value) === 'true') {
        // Equal to null
        return convertWhere(model, field, 'eq', null, mode);
      } else {
        // Not equal to null
        return convertWhere(model, field, 'ne', null, mode);
      }

    default:
      // If Strapi adds other operators in the future then they
      // will be passed directly to Firestore which will most
      // likely result in an error
      op = operator;
  }

  if (mode === 'manualOnly') {
    if (typeof op !== 'function') {
      op = fsOps[op];
      if (!op) {
        throw new Error(`Unknown operator could not be converted to a function: "${operator}".`);
      }
    }
  }

  if ((mode === 'nativeOnly') && (typeof op === 'function')) {
    throw new Error(`Operator "${operator}" is not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query.`);  
  }

  const path = fieldPathToPath(model, field);
  const attr: StrapiAttribute = (path === model.primaryKey) ? { type: 'string' } : model.attributes[path];

  if (attr.type === 'password') {
    throw new StatusError('Not allowed to query password fields', 404);
  }

  // Coerce the attribute into the correct type
  value = coerceAttribute(attr, value);
  
  if (typeof op === 'function') {
    const fn = op;
    return(snap: PartialSnapshot<any>) => {
      const fieldValue = getAtPath(model, path, snap);
      return fn(fieldValue, value);
    };
  } else {
    if (field === model.primaryKey) {
      field = FieldPath.documentId();
    }
    return {
      field,
      operator: op,
      value,
    };
  }
}



function coerceAttribute(attr: StrapiAttribute | undefined, value: unknown): unknown {
  if (Array.isArray(value)) {
    value = value.map(v => coerceAttrToModel(attr, v, {}));
  } else {
    value = coerceAttrToModel(attr, value, {});
  }
  return value;
}


interface TestFn<A = any, B = any> {
  (fieldValue: A, filterValue: B): boolean
}

/**
 * Defines a manual equivalent for every native Firestore operator.
 */
const fsOps: { [op in WhereFilterOp]: TestFn } = {
  '==': isEqualHandlingRef,
  '!=': (fieldValue, filterValue) => !isEqualHandlingRef(fieldValue, filterValue),
  '<': _.lt,
  '<=': _.lte,
  '>': _.gt,
  '>=': _.gte,
  'in': (fieldValue, filterValue: any[]) => filterValue.some(v => isEqualHandlingRef(v, fieldValue)),
  'not-in': (fieldValue, filterValue: any[]) => filterValue.every(v => !isEqualHandlingRef(v, fieldValue)),
  'array-contains': (fieldValue, filterValue) => {
    if (Array.isArray(fieldValue)) {
      return _.some(fieldValue, v => isEqualHandlingRef(filterValue, v));
    } else {
      return false;
    }
  },
  'array-contains-any': (fieldValue, filterValue) => {
    if (Array.isArray(fieldValue)) {
      return _.some(fieldValue, val => _.some(filterValue, v => isEqualHandlingRef(val, v)));
    } else {
      return false;
    }
  }
};

const contains: TestFn = (fieldValue, filterValue: any[]) => {
  const lv = _.toLower(fieldValue);
  return filterValue.some(v => _.includes(lv, v));
};

const ncontains: TestFn = (fieldValue, filterValue: any[]) => {
  const lv = _.toLower(fieldValue);
  return filterValue.every(v => !_.includes(lv, v));
};

const containss: TestFn = (fieldValue, filterValue: any[]) => {
  return filterValue.some(v => _.includes(fieldValue, v));
};

const ncontainss: TestFn = (fieldValue, filterValue: any[]) => {
  return filterValue.every(v => !_.includes(fieldValue, v));
};
