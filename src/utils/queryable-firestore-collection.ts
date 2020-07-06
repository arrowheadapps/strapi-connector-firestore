import * as _ from 'lodash';
import { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { Query, Transaction, QueryDocumentSnapshot, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';
import { ManualFilter, convertWhere, convertWhereManual } from './convert-where';


export class QueryableFirestoreCollection implements QueryableCollection {

  private readonly query: Query
  private manualFilters: ManualFilter[] = [];
  private orFilters: ManualFilter[] = [];
  private _limit?: number;

  constructor(other: Query | QueryableFirestoreCollection, limit?: number) {
    if (other instanceof QueryableFirestoreCollection) {
      this.query = other.query;
      this._limit = other._limit;
    } else {
      this.query = other;
    }
    this._limit = limit;
  }

  get(trans?: Transaction): Promise<QuerySnapshot> {
    return manualQuery(this.query, this.manualFilters, this.orFilters, this._limit || 0, trans);
  }

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, combinator: 'and' | 'or' = 'and'): QueryableCollection {
    if (combinator === 'or') {
      // Push to manual 'OR' filters
      const other = new QueryableFirestoreCollection(this.query);
      const { operator: op } = convertWhereManual(field, operator, value);
      other.orFilters.push(op);
      return other;
    } else {
      // Push to normal 'AND' filters
      const filter = convertWhere(field, operator, value);
      if (typeof filter.operator === 'function') {
        const other = new QueryableFirestoreCollection(this.query);
        other.manualFilters.push(filter.operator);
        return other;
      } else {
        return new QueryableFirestoreCollection(this.query.where(filter.field, filter.operator, filter.value));
      }
    }
  }

  orderBy(field: string | FieldPath, directionStr: "desc" | "asc" = 'asc'): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.orderBy(field, directionStr));
  }

  limit(limit: number): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.limit(limit), limit);
  }

  offset(offset: number): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.offset(offset));
  }
}



async function manualQuery(baseQuery: Query, manualFilters: ManualFilter[], orFilters: ManualFilter[], limit: number, transaction: Transaction | undefined): Promise<QuerySnapshot> {

  let cursor: QueryDocumentSnapshot | undefined
  let docs: Snapshot[] = [];
  while (docs.length < limit) {
    if (limit) {
      baseQuery = baseQuery.limit(limit);
    }
    if (cursor) {
      baseQuery = baseQuery.startAfter(cursor);
    }

    const result = await (transaction ? transaction.get(baseQuery) : baseQuery.get());
    if (result.empty) {
      break;
    }

    let resultDocs = result.docs;
    cursor = resultDocs[resultDocs.length - 1];
    if (manualFilters.length) {
      // Entry must match every 'AND' filter
      resultDocs = resultDocs.filter((doc) => manualFilters.every(op => op(doc)));
    }

    if (orFilters.length) {
      // Entry must match any of the 'OR' filters
      resultDocs = resultDocs.filter((doc) => manualFilters.some(op => op(doc)));
    }

    if ((docs.length + resultDocs.length) > limit) {
      docs = docs.concat(resultDocs.slice(0, limit - docs.length));
    } else {
      docs = docs.concat(resultDocs);
    }
  }

  return {
    docs,
    empty: docs.length === 0
  };
}
