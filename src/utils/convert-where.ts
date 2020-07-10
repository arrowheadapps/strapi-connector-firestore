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

export function convertWhere(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): WhereFilter<WhereFilterOp | ManualFilter> {
  return convertWhereImpl(field, operator, value, false);
}

export function convertWhereManual(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): WhereFilter<ManualFilter> {
  return convertWhereImpl(field, operator, value, true) as WhereFilter<ManualFilter>;
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
function convertWhereImpl(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, manualOnly: boolean) {
  const eq = val => v => _.isEqual(val, v);
  const ne = val => v => !_.isEqual(val, v);

  let op: WhereFilterOp | ((data: Snapshot) => boolean);
  switch (operator) {
    case '==':
    case 'eq':
      // Equals
      op = manualOnly ?  manualWhere(field, eq(value)) : '==';
      break;

    case 'ne':
      // Not equal
      op = manualWhere(field, ne(value));
      break;

    case 'in':
      // Included in an array of values
      // `value` must be an array
      if (!_.isArray(value)) {
        throw new Error(`"in" operator requires an array value (got "${typeof value}")`);
      }
      op = manualOnly ? manualWhere(field, v => _.some(value, eq(v))) : 'in';
      break;

    case 'nin':
      // Included in an array of values
      // `value` must be an array
      if (!_.isArray(value)) {
        throw new Error(`"nin" operator requires an array value (got "${typeof value}")`);
      }
      op = manualWhere(field, v => _.every(value, ne(v)));
      break;

    case 'contains':
      // String includes value
      op = manualWhere(field, v => _.includes(v, value));
      break;

    case 'ncontains':
      // String doesn't include value
      op = manualWhere(field, v => !_.includes(v, value));
      break;

    case 'containss':
      // String includes value case insensitive
      op = manualWhere(field, v => _.includes(_.toLower(v), _.toLower(value)));
      break;

    case 'ncontainss':
      // String doesn't value case insensitive
      op = manualWhere(field, v => !_.includes(_.toLower(v), _.toLower(value)));
      break;

    case '<':
    case 'lt':
      // Less than
      op = manualOnly ? manualWhere(field, v => v < value) : '<';
      break;

    case '<=':
    case 'lte':
      // Less than or equal
      op = manualOnly ? manualWhere(field, v => v <= value) : '<=';
      break;

    case '>':
    case 'gt':
      // Greater than
      op = manualOnly ? manualWhere(field, v => v > value) : '>';
      break;

    case '>=':
    case 'gte':
      // Greater than or equal
      op = manualOnly ? manualWhere(field, v => v >= value) : '>=';
      break;

    case 'null':
      if (value) {
        // Equal to null
        value = null;
        op = manualOnly ? manualWhere(field, v => v == null) : '==';
      } else {
        // Not equal to null
        op = manualWhere(field, v => v != null);
      }
      break;

    default:
      if (operator instanceof RegExp) {
        op = manualWhere(field, val => operator.test(val));
        value = undefined;
      } else {
        if (manualOnly) {
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
              if (!_.isArray(value)) {
                throw new Error(`"array-contains-any" operator requires an array value (got "${typeof value}")`);
              }
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

  if (manualOnly && (typeof op !== 'function')) {
    throw new Error(`Unknown operator could not be converted to a function: "${operator}".`);
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
