import * as _ from 'lodash';
import { WhereFilterOp, FieldPath } from '@google-cloud/firestore';
import type { Attribute, Model, ModelData, OrClause, WhereClause } from 'strapi';
import { coerceAttrToModel } from '../coerce/coerce-to-model';
import { isEqualHandlingRef, Snapshot } from '../db/reference';
import { mapNotNull } from './map-not-null';

const FIRESTORE_MAX_ARRAY_ELEMENTS = 10;

export class EmptyQueryError extends Error {
  constructor() {
    super('Query parameters will result in an empty response');
  }
}

export type PartialSnapshot<T extends ModelData> =
  Pick<Snapshot<T>, 'data'> &
  Pick<Snapshot<T>, 'id'>;

export interface ManualFilter {
  (data: PartialSnapshot<any>): boolean
}

export interface FirestoreFilter {
  field: string | FieldPath
  operator: WhereFilterOp
  value: any
}

export function fieldPathToPath(model: Model<any>, field: string | FieldPath): string {
  if (field instanceof FieldPath) {
    if (FieldPath.documentId().isEqual(field)) {
      return model.primaryKey;
    }
    return field.toString();
  }
  return field;
}

export function getAtPath<T extends ModelData>(model: Model<T>, path: string, data: PartialSnapshot<T>): any {
  if (path === model.primaryKey) {
    return data.id;
  }
  return _.get(data.data(), path, undefined);
}

export function getAtFieldPath<T extends ModelData>(model: Model<T>, path: string | FieldPath, data: Snapshot<T>): any {
  return getAtPath(model, fieldPathToPath(model, path), data);
}


/**
 * Convert a Strapi or Firestore query operator to a Firestore operator
 * or a manual function.
 */
export function convertWhere(model: Model<any>, { field, operator, value }:  WhereClause | OrClause | FirestoreFilter, mode: 'manualOnly'): ManualFilter | null
export function convertWhere(model: Model<any>, { field, operator, value }:  WhereClause | OrClause | FirestoreFilter, mode: 'nativeOnly'): FirestoreFilter | null
export function convertWhere(model: Model<any>, { field, operator, value }:  WhereClause | OrClause | FirestoreFilter, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): FirestoreFilter | ManualFilter | null
export function convertWhere(model: Model<any>, { field, operator, value }:  WhereClause | OrClause | FirestoreFilter, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): FirestoreFilter | ManualFilter | null {
  
  if (operator === 'or') {
    const filters: OrClause['value'] = _.castArray(value || []);
    if (!filters.length) {
      throw new EmptyQueryError();
    }

    // Optimise OR filters where possible with native versions (e.g. 'in' and 'not-in')
    const consolidated = consolidateOrFilters(filters);
    if (consolidated) {
      field = consolidated.field;
      operator = consolidated.operator;
      value = consolidated.value;
    } else {
      if (mode === 'nativeOnly') {
        throw strapi.errors.badRequest(`OR filters are not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query`);  
      }
      
      const orFilters: ManualFilter[] = mapNotNull(filters, andFilters => {
        try {
          // Combine the AND filters within this OR filter
          const convertedAndFilters = andFilters.map(filter => convertWhere(model, filter, 'manualOnly'));
          return snap => {
            for (const f of convertedAndFilters) {
              if (f && !f(snap))
                return false;
            }
            return true;
          }
        } catch (err) {
          // If any of the AND filters within this OR filter are empty
          // Then ignore this OR filter (i.e. "or false" has no effect)
          if (err instanceof EmptyQueryError) {
            return null;
          } else {
            throw err;
          }
        }
      });

      if (!orFilters.length) {
        throw new EmptyQueryError();
      }

      return snap => {
        for (const f of orFilters) {
          if (f(snap))
            return true;
        }
        return false;
      }
    }
  }

  if (!field) {
    throw strapi.errors.badRequest(`Query field must not be empty, received: ${JSON.stringify(field)}`);
  }

  let op: WhereFilterOp | ((filterValue: any, fieldValue: any) => boolean);
  switch (operator) {
    case '==':
    case 'eq':
      if (Array.isArray(value)) {
        // Equals any (OR)
        // I.e. "in"
        return convertWhere(model, { field, operator: 'in', value }, mode);
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
        return convertWhere(model, { field, operator: 'not-in', value }, mode);
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
      // Implicitly handle OR case by casting array
      value = _.castArray(value);
      op = contains;
      break;

    case 'ncontains':
      // NO NATIVE SUPPORT
      // String doesn't contain value case insensitive
      // Implicitly handle OR case by casting array
      value = _.castArray(value);
      op = ncontains;
      break;

    case 'containss':
      // NO NATIVE SUPPORT
      // String includes value
      // Implicitly handle OR case by casting array
      value = _.castArray(value);
      op = containss;
      break;

    case 'ncontainss':
      // NO NATIVE SUPPORT
      // String doesn't include value
      // Implicitly handle OR case by casting array
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
      if ((value === true) || _.toLower(value) === 'true') {
        // Equal to null
        return convertWhere(model, { field, operator: '==', value: null }, mode);
      } else {
        // Not equal to null
        return convertWhere(model, { field, operator: '!=', value: null }, mode);
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
    throw strapi.errors.badRequest(`Operator "${operator}" is not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query`);  
  }

  const path = fieldPathToPath(model, field);
  const attr: Attribute | undefined = (path === model.primaryKey) ? { type: 'string' } : model.attributes[path];
  if (attr?.type === 'password') {
    throw strapi.errors.badRequest('Not allowed to query password fields');
  }

  // Coerce the attribute into the correct type
  try {
    value = coerceAttribute(attr, value);
  } catch (err) {
    // If the value cannot be coerced to the appropriate type
    // then this filter will reject all entries
    throw new EmptyQueryError();
  }
  
  if (typeof op === 'function') {
    const testFn = op;
    return snap => {
      const fieldValue = getAtPath(model, path, snap);
      return testFn(fieldValue, value);
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

function coerceAttribute(attr: Attribute | undefined, value: unknown): unknown {
  // Use editMode == 'update' so that strict coercion rules will be applies
  // An error will be thrown rather than silently ignoring
  if (Array.isArray(value)) {
    value = value.map(v => coerceAttrToModel(attr, v, { editMode: 'update' }));
  } else {
    value = coerceAttrToModel(attr, value, { editMode: 'update' });
  }
  return value;
}

/**
 * Returns the field, operator, and corresponding values if an only if
 * the all fields and operators are the same, and the operator is one of `'eq'` or `'ne'`,
 * otherwise returns `null`.
 */
function consolidateOrFilters(filters: OrClause['value']): WhereClause | null {
  let opAndField: { field: string, operator: 'eq' | 'ne' } | undefined;
  let values: any[] = [];

  for (const andFilters of filters) {
    if (andFilters.length !== 1) {
      return null;
    }
    const [{ field, operator, value }] = andFilters;
    if (opAndField) {
      if ((operator === opAndField.operator) && (field == opAndField.field)) {
        values = values.concat(value);
      } else {
        return null;
      }
    } else if ((operator === 'eq') || (operator === 'ne')) {
      opAndField = { field, operator };
      values  = values.concat(value);
    }
    return null;
  }

  if (!opAndField) {
    return null;
  }

  return {
    field: opAndField.field,
    operator: opAndField.operator === 'eq' ? 'in' : 'nin',
    value: values,
  };
}


interface TestFn<A = any, B = any> {
  (fieldValue: A, filterValue: B): boolean
}

const inFn: TestFn<any, any[]> = (fieldValue, filterValue) => {
  for (const v of filterValue) {
    if (isEqualHandlingRef(fieldValue, v))
      return true;
  }
  return false;
};

/**
 * Defines a manual equivalent for every native Firestore operator.
 */
const fsOps: { [op in WhereFilterOp]: TestFn } = {
  '==': isEqualHandlingRef,
  '!=': _.negate(isEqualHandlingRef),
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  'in': inFn,
  'not-in': _.negate(inFn),
  'array-contains': (fieldValue, filterValue) => {
    if (Array.isArray(fieldValue)) {
      for (const v of fieldValue) {
        if (isEqualHandlingRef(v, filterValue))
          return true;
      }
    }
    return false;
  },
  'array-contains-any': (fieldValue, filterValue: any[]) => {
    if (Array.isArray(fieldValue)) {
      for (const val of fieldValue) {
        for (const v of filterValue) {
          if (isEqualHandlingRef(v, val))
            return true;
        }
      }
    }
    return false;
  }
};

/**
 * Any of filterValue's are contained in field value, case insensitive.
 */
const contains: TestFn<any, string[]> = (fieldValue, filterValue) => {
  if (typeof fieldValue === 'string') {
    const uprFieldValue = fieldValue.toUpperCase();
    for (const v of filterValue) {
      const uprV = (typeof v === 'string') ? v.toUpperCase() : v;
      if (uprFieldValue.includes(uprV))
        return true;
    }
  }
  return false;
};

/**
 * Any of filterValue's are not contained in field value, case insensitive.
 * This is not the same as the negation of `contains` (that would mean:
 * *all* of filterValue's are not contains in field value)
 */
const ncontains: TestFn<any, string[]> = (fieldValue, filterValue) => {
  if (typeof fieldValue === 'string') {
    const uprFieldValue = fieldValue.toUpperCase();
    for (const v of filterValue) {
      const uprV = (typeof v === 'string') ? v.toUpperCase() : v;
      if (!uprFieldValue.includes(uprV))
        return true;
    }
  }
  return false;
};

/**
 * Any of filterValue's are contained in field value.
 */
const containss: TestFn<any, string[]> = (fieldValue, filterValue) => {
  if (typeof fieldValue === 'string') {
    for (const v of filterValue) {
      if (fieldValue.includes(v))
        return true;
    }
  }
  return false;
};

/**
 * Any of filterValue's are not contained in field value.
 * This is not the same as the negation of `contains` (that would mean:
 * *all* of filterValue's are not contains in field value)
 */
const ncontainss: TestFn<any, string[]> = (fieldValue, filterValue) => {
  if (typeof fieldValue === 'string') {
    for (const v of filterValue) {
      if (!fieldValue.includes(v))
        return true;
    }
  }
  return false;
};
