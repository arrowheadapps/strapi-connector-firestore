import * as _ from 'lodash';
import { WhereFilterOp, FieldPath, DocumentReference } from '@google-cloud/firestore';
import type { Snapshot } from './queryable-collection';
import type { StrapiWhereOperator } from '../types';

export type ManualFilter = ((data: Snapshot) => boolean);

export interface WhereFilter {
  field: string | FieldPath
  operator: WhereFilterOp
  value: any
}

export function getFieldPath(field: string | FieldPath, data: Snapshot): any {
  if (field instanceof FieldPath) {
    if (!FieldPath.documentId().isEqual(field)) {
      throw new Error('The provided field path is not supported');
    }
    return data.id;
  } else {
    return _.get(data.data(), field, undefined);
  }
}

export function manualWhere(field: string | FieldPath, predicate: (fieldValue: any) => boolean) {
  return (docData: Snapshot) => {
    const value = getFieldPath(field, docData);
    
    return predicate(value);
  };
}

/**
 * Convert a Strapi or Firestore query operator to a Firestore operator
 * or a manual function.
 */
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, mode: 'manualOnly'): ManualFilter
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, mode: 'nativeOnly'): ManualFilter
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): WhereFilter | ManualFilter
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, mode: 'manualOnly' | 'nativeOnly' | 'preferNative'): WhereFilter | ManualFilter {
  let op: WhereFilterOp | ManualFilter;
  switch (operator) {
    case '==':
    case 'eq':
      if (_.isArray(value)) {
        // Equals any (OR)
        // I.e. "in"
        return convertWhere(field, 'in', value, mode);
      } else {
        // Equals
        op = (mode === 'manualOnly') ?  manualWhere(field, eq(value)) : '==';
        break;
      }

    case '!=':
    case 'ne':
      if (_.isArray(value)) {
        // Not equals any (OR)
        // I.e. "nin"
        return convertWhere(field, 'nin', value, mode);
      } else {
        // Not equal
        op = (mode === 'manualOnly') ? manualWhere(field, ne(value)) : '!=';
        break;
      }

    case 'in':
      // Included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      op = (mode === 'manualOnly') ? manualWhere(field, v => value.some(eq(v))) : 'in';
      break;

    case 'not-in':
    case 'nin':
      // Not included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      op = (mode === 'manualOnly') ? manualWhere(field, v => value.every(ne(v))) : 'not-in';
      break;

    case 'contains':
      // NO NATIVE SUPPORT
      // String includes value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = manualWhere(field, v => {
        const lv = _.toLower(v);
        return value.some(val => includes(lv, val));
      });
      break;

    case 'ncontains':
      // NO NATIVE SUPPORT
      // String doesn't value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = manualWhere(field, v => {
        const lv = _.toLower(v);
        return value.some(val => !includes(lv, val));
      });
      break;

    case 'containss':
      // NO NATIVE SUPPORT
      // String includes value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = manualWhere(field, v => value.some(val => includes(v, val)));
      break;

    case 'ncontainss':
      // NO NATIVE SUPPORT
      // String doesn't include value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = manualWhere(field, v => value.some(val => !includes(v, val)));
      break;

    case '<':
    case 'lt':
      if (_.isArray(value)) {
        // Less than any (OR)
        // Just take the maximum
        value = _.max(value);
      }
      // Less than
      op = (mode === 'manualOnly') ? manualWhere(field, v => v < value) : '<';
      break;

    case '<=':
    case 'lte':
      if (_.isArray(value)) {
        // Less than any (OR)
        // Just take the maximum
        value = _.max(value);
      }
      // Less than or equal
      op = (mode === 'manualOnly') ? manualWhere(field, v => v <= value) : '<=';
      break;

    case '>':
    case 'gt':
      if (_.isArray(value)) {
        // Greater than any (OR)
        // Just take the minimum
        value = _.min(value);
      }
      // Greater than
      op = (mode === 'manualOnly') ? manualWhere(field, v => v > value) : '>';
      break;

    case '>=':
    case 'gte':
      if (_.isArray(value)) {
        // Greater than any (OR)
        // Just take the minimum
        value = _.min(value);
      }
      // Greater than or equal
      op = (mode === 'manualOnly') ? manualWhere(field, v => v >= value) : '>=';
      break;

    case 'null':
      if (_.toLower(value) === 'true') {
        // Equal to null
        return convertWhere(field, 'eq', null, mode);
      } else {
        // Not equal to null
        return convertWhere(field, 'ne', null, mode);
      }
      break;

    default:
      if (operator instanceof RegExp) {
        op = manualWhere(field, val => operator.test(val));
        value = undefined;
      } else {
        if (mode === 'manualOnly') {
          switch (operator) {
            case 'array-contains':
              // Array contains value
              op = manualWhere(field, v => {
                if (_.isArray(v)) {
                  return _.some(v, eq(value));
                } else {
                  return false;
                }
              });
              break;

            case 'array-contains-any':
              // Array contans any values in array
              // `value` must be an array
              value = _.castArray(value);
              op = manualWhere(field, v => {
                if (_.isArray(v)) {
                  return _.some(v, val => _.some(value, eq(val)));
                } else {
                  return false;
                }
              });
              break;

            default:
              // Unknown operator cannot be converted to manual function
              // TypeScript will help us here to detect unhandled cases
              guardManual(operator);
          }
        } else {
          // If Strapi adds other operators in the future
          // then we will end up passing it directly to Firestore
          // which will likely throw an error
          op = operator;
        }
      }
  }

  if ((mode === 'manualOnly') && (typeof op !== 'function')) {
    throw new Error(`Unknown operator could not be converted to a function: "${operator}".`);
  }

  if ((mode === 'nativeOnly') && (typeof op === 'function')) {
    const type = operator instanceof RegExp ? 'RegExp' : operator;
    throw new Error(`Operator "${type}" is not supported natively by Firestore. Use the \`allowNonNativeQueries\` option to enable a manual version of this query.`);  
  }

  if (typeof op === 'function') {
    return op;
  } else {
    return {
      field,
      operator: op,
      value
    };
  }
}

function guardManual(op: never): never {
  throw new Error(`Unsupported operator: "${op}"`);
}

function eq(val) {
  return v => isEqual(val, v);
}

function ne(val) {
  return v => !isEqual(val, v);
}

/**
 * Special equality algorithim that handles DocumentReference instances.
 */
function isEqual(a: any, b: any): boolean {
  a = (a instanceof DocumentReference) ?  a.path : a;
  b = (b instanceof DocumentReference) ?  b.path : b;
  return _.isEqual(a, b);
}

/**
 * Special string includes algorithm that handles DocumentReference instances.
 */
function includes(a: any, b: any): boolean {
  a = (a instanceof DocumentReference) ?  a.path : a;
  b = (b instanceof DocumentReference) ?  b.path : b;
  return _.includes(a, b);
}
