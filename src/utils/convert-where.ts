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

function convertWhereImpl(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, manualOnly: boolean) {
  
  let op: WhereFilterOp | ((data: Snapshot) => boolean);
  switch (operator) {
    case 'eq':
      op = manualOnly ?  manualWhere(field, val => val == value) : '==';
      break;
    case 'ne':
      op = manualWhere(field, val => val != value);
      break;
    case 'in':
      // FIXME:
      op = manualOnly ? manualWhere(field, val => _.includes(val, value)) : 'in';
      break;
    case 'nin':
      op = manualWhere(field, val => !_.includes(val, value));
      break;
    case 'contains':
      op = manualWhere(field, val => _.includes(val, value));
      break;
    case 'ncontains':
      op = manualWhere(field, val => !_.includes(val, value));
      break;
    case 'containss':
      op = manualWhere(field, val => _.includes(_.toLower(val), _.toLower(value)));
      break;
    case 'ncontainss':
      op = manualWhere(field, val => !_.includes(_.toLower(val), _.toLower(value)));
      break;
    case 'lt':
      op = manualOnly ? manualWhere(field, val => val < value) : '<';
      break;
    case 'lte':
      op = manualOnly ? manualWhere(field, val => val <= value) : '<=';
      break;
    case 'gt':
      op = manualOnly ? manualWhere(field, val => val > value) : '>';
      break;
    case 'gte':
      op = manualOnly ? manualWhere(field, val => val >= value) : '>=';
      break;
    case 'null':
      if (value) {
        value = null;
        op = manualOnly ? manualWhere(field, val => val == value) : '==';
      } else {
        op = manualWhere(field, val => val != null);
      }
      break;
    default:
      if (operator instanceof RegExp) {
        op = manualWhere(field, val => operator.test(val));
        value = undefined;
      } else {
        if (manualOnly) {
          switch (operator) {
            case '==':
              op = manualWhere(field, val => val == value);
              break;
            case '<':
              op = manualWhere(field, val => val < value);
              break;
            case '<=':
              op = manualWhere(field, val => val <= value);
              break;
            case '>':
              op = manualWhere(field, val => val > value);
              break;
            case '>=':
              op = manualWhere(field, val => val >= value);
              break;
            case 'array-contains':
              // FIXME:
              // How are we measuring equality
              op = manualWhere(field, val => _.includes(val, value));
              break;
            case 'array-contains-any':
              // FIXME:
              // How are we measuring equality
              op = manualWhere(field, val => _.intersection(val, value).length > 0);
              break;
            default:
              // FIXME: how to handle?
              op = operator;
          }
        } else {
          // If Strapi adds other operators in the future
          // then we will end up passing it directly to Firestore
          // which will likely throw an error
          op = operator;
        }
      }
  }

  return {
    field,
    operator: op,
    value
  };
}
