import * as _ from 'lodash';
import { WhereFilterOp, FieldPath } from '@google-cloud/firestore';
import type { FirestoreFilter, StrapiAttribute, StrapiOrFilter, StrapiWhereFilter } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { coerceAttrToModel, CoercionError } from '../coerce/coerce-to-model';
import { isEqualHandlingRef } from '../db/reference';
import { StatusError } from './status-error';
import { mapNotNull } from './map-not-null';
import { ManualFilter } from './manual-filter';

const FIRESTORE_MAX_ARRAY_ELEMENTS = 10;

export class EmptyQueryError extends Error {
  constructor() {
    super('Query parameters will result in an empty response');
  }
}


/**
 * Convert a Strapi or Firestore query operator to a Firestore operator
 * or a manual function.
 */
export function convertWhere(model: FirestoreConnectorModel<any>, { field, operator, value }:  StrapiWhereFilter | StrapiOrFilter | FirestoreFilter, mode: 'manualOnly'): ManualFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, { field, operator, value }:  StrapiWhereFilter | StrapiOrFilter | FirestoreFilter, mode: 'nativeOnly'): FirestoreFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, { field, operator, value }:  StrapiWhereFilter | StrapiOrFilter | FirestoreFilter, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): FirestoreFilter | ManualFilter | null
export function convertWhere(model: FirestoreConnectorModel<any>, { field, operator, value }:  StrapiWhereFilter | StrapiOrFilter | FirestoreFilter, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): FirestoreFilter | ManualFilter | null {
  
  
  if (operator === 'or') {
    const filters: StrapiOrFilter['value'] = _.castArray(value || []);
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
        throw new StatusError(`OR filters are not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query.`, 400);  
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
    throw new StatusError(`Query field must not be empty, received: ${JSON.stringify(field)}.`, 400);
  }

  const attr = model.getAttribute(field);
  if (attr && attr.type === 'password') {
    throw new StatusError('Not allowed to query password fields', 400);
  }

  // Determine if the target attribute is an array
  // Meta attributes have "repeatable" set to true
  const attrIsArray = attr && (attr.collection || attr.repeatable);

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
      // Implicitly convert 'in' operator to 'array-contains-any' if the target is an array
      const actualOp: WhereFilterOp = attrIsArray ? 'array-contains-any' : 'in';

      // Included in an array of values
      // `value` must be an array, don't coerce as it's likely to be an error if it's not an array
      if (!Array.isArray(value) || value.some(v => v === undefined)) {
        throw new StatusError(`value for 'in' filter must be an array without undefined values`, 400);
      }
      if ((value as any[]).length === 0) {
        throw new EmptyQueryError();
      }
      op = ((value as any[]).length > FIRESTORE_MAX_ARRAY_ELEMENTS) 
        ? fsOps[actualOp] 
        : actualOp;
      break;

    case 'not-in':
    case 'nin':
      // Not included in an array of values
      // `value` must be an array, don't coerce as it's likely to be an error if it's not an array
      if (!Array.isArray(value) || value.some(v => v === undefined)) {
        throw new StatusError(`value for 'in' filter must be an array without undefined values`, 400);
      }
      if (value.length === 0) {
        return null;
      }
      // If the target is an array, then we implicitly use an 'array-contains-none' operation, but this
      // is only supported by manual query, not by native Firestore
      // TODO: Don't do as above, because this will cause a built-in Strapi query to fail (find users without a role using role_nin)
      // so just ignore for now (that query won't function, but at least Strapi doesn't crash)
      op = ((value.length > FIRESTORE_MAX_ARRAY_ELEMENTS) /*|| attrIsArray*/)
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

    case 'array-contains-any':
      // Array includes any value in the given array
      // `value` must be an array, don't coerce as it's likely to be an error if it's not an array
      if (!Array.isArray(value) || value.some(v => v === undefined)) {
        throw new StatusError(`value for 'array-contains-any' filter must be an array without undefined values`, 400);
      }
      if (value.length === 0) {
        throw new EmptyQueryError();
      }
      op = (value.length > FIRESTORE_MAX_ARRAY_ELEMENTS) 
        ? fsOps['array-contains-any'] 
        : 'array-contains-any';
      break;


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
    throw new StatusError(`Operator "${operator}" is not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query.`, 400);  
  }

  // Coerce the attribute into the correct type
  try {
    value = coerceAttribute(attr, value, { ignoreMismatchedReferences: model.options.ignoreMismatchedReferences });
  } catch (err) {
    if (err instanceof CoercionError) {
      // If the value cannot be coerced to the appropriate type
      // then this filter will reject all entries
      throw new EmptyQueryError();
    } else {
      throw err;
    }
  }
  
  if (typeof op === 'function') {
    const path = field;
    const testFn = op;
    return snap => {
      const fieldValue = model.getAttributeValue(path, snap);
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

function coerceAttribute(attr: StrapiAttribute | undefined, value: unknown, opts: { ignoreMismatchedReferences: boolean }): unknown {
  // Use editMode == 'update' so that strict coercion rules will be applies
  // An error will be thrown rather than silently ignoring
  if (Array.isArray(value)) {
    value = value.map(v => coerceAttrToModel(attr, v, { ...opts, editMode: 'update' }));
  } else {
    value = coerceAttrToModel(attr, value, { ...opts, editMode: 'update' });
  }
  return value;
}

/**
 * Returns the field, operator, and corresponding values if an only if
 * the all fields and operators are the same, and the operator is one of `'eq'` or `'ne'`,
 * otherwise returns `null`.
 */
function consolidateOrFilters(filters: StrapiOrFilter['value']): StrapiWhereFilter | null {
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
  if (Array.isArray(fieldValue)) {
    // Any element is equal to any value in the filter value array
    for (const val of fieldValue) {
      for (const v of filterValue) {
        if (isEqualHandlingRef(val, v))
          return true;
      }
    }
  } else {
    // Equal to any value in the filter value array
    for (const v of filterValue) {
      if (isEqualHandlingRef(fieldValue, v))
        return true;
    }
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
