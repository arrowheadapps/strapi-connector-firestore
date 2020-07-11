import * as _ from 'lodash';
import { WhereFilterOp, FieldPath } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';
import { Snapshot } from './queryable-collection';

export type ManualFilter = ((data: Snapshot) => boolean);

export interface WhereFilter<T> {
  field: string | FieldPath
  operator: T
  value: any
}

export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, allowNonNativeQueries: false): WhereFilter<WhereFilterOp>
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, allowNonNativeQueries: boolean): WhereFilter<WhereFilterOp | ManualFilter>
export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, allowNonNativeQueries: boolean): WhereFilter<WhereFilterOp | ManualFilter> {
  return convertWhereImpl(field, operator, value, allowNonNativeQueries ? 'preferNative' : 'nativeOnly');
}

export function convertWhereManual(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): WhereFilter<ManualFilter> {
  return convertWhereImpl(field, operator, value, 'manualOnly') as WhereFilter<ManualFilter>;
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
function convertWhereImpl(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, mode: 'manualOnly' | 'nativeOnly' | 'preferNative') {
  // We use both the _.isEqual (to handle objects etc)
  // and the standard operator (because _.isEqual considers '42' == 42)
  // whereas we need them to equal 
  // Numbers received via querystring will be strings
  const eq = val => v => ((val == v) || _.isEqual(val, v));
  const ne = val => v => ((val != v) && !_.isEqual(val, v));

  let op: WhereFilterOp | ((data: Snapshot) => boolean);
  switch (operator) {
    case '==':
    case 'eq':
      if (_.isArray(value)) {
        // Equals any (OR)
        // I.e. "in"
        return convertWhereImpl(field, 'in', value, mode);
      } else {
        // Equals
        op = (mode === 'manualOnly') ?  manualWhere(field, eq(value)) : '==';
        break;
      }

    case 'ne':
      if (_.isArray(value)) {
        // Not equals any (OR)
        // I.e. "nin"
        return convertWhereImpl(field, 'nin', value, mode);
      } else {
        // NO NATIVE SUPPORT
        // Not equal

        // TODO: 
        // Can we improve performance and support 'nativeOnly'
        // by combining native '<' and '>' queries?
        op = manualWhere(field, ne(value));
        break;
      }

    case 'in':
      // Included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      op = (mode === 'manualOnly') ? manualWhere(field, v => value.some(eq(v))) : 'in';
      break;

    case 'nin':
      // NO NATIVE SUPPORT
      // Included in an array of values
      // `value` must be an array
      value = _.castArray(value);
      op = manualWhere(field, v => value.every(ne(v)));
      break;

    case 'contains':
      // NO NATIVE SUPPORT
      // String includes value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = manualWhere(field, v => {
        const lv = _.toLower(v);
        return value.some(val => _.includes(lv, val));
      });
      break;

    case 'ncontains':
      // NO NATIVE SUPPORT
      // String doesn't value case insensitive
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value).map(v => _.toLower(v));
      op = manualWhere(field, v => {
        const lv = _.toLower(v);
        return value.some(val => !_.includes(lv, val));
      });
      break;

    case 'containss':
      // NO NATIVE SUPPORT
      // String includes value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = manualWhere(field, v => value.some(val => _.includes(v, val)));
      break;

    case 'ncontainss':
      // NO NATIVE SUPPORT
      // String doesn't include value
      // Inherently handle 'OR' case (when value is an array)
      value = _.castArray(value);
      op = manualWhere(field, v => value.some(val => !_.includes(v, val)));
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
      if (value) {
        // Equal to null
        return convertWhereImpl(field, 'eq', null, mode);
      } else {
        // Not equal to null
        return convertWhereImpl(field, 'ne', null, mode);
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

  return {
    field,
    operator: op,
    value
  };
}

function guardManual(op: never): never {
  throw new Error(`Unsupported operator: "${op}"`);
}
