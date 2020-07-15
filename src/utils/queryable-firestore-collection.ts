import * as _ from 'lodash';
import { ManualFilter, convertWhere } from './convert-where';
import { Query, Transaction, QueryDocumentSnapshot, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { StrapiWhereOperator } from '../types';


export class QueryableFirestoreCollection implements QueryableCollection {

  private allowNonNativeQueries: boolean
  private query: Query
  private manualFilters: ManualFilter[] = [];
  private _limit?: number;
  private _offset?: number;

  constructor(other: QueryableFirestoreCollection)
  constructor(other: Query, allowNonNativeQueries: boolean)
  constructor(other: Query | QueryableFirestoreCollection, allowNonNativeQueries?: boolean) {
    if (other instanceof QueryableFirestoreCollection) {
      this.allowNonNativeQueries = other.allowNonNativeQueries;
      this.query = other.query;
      this.manualFilters = other.manualFilters.slice();
      this._limit = other._limit;
      this._offset = other._offset;
    } else {
      this.query = other;
      this.allowNonNativeQueries = allowNonNativeQueries || false;
      this.orderBy(FieldPath.documentId(), 'asc');
    }
  }

  get(trans?: Transaction): Promise<QuerySnapshot> {
    return manualQuery(this.query, this.manualFilters, this._limit || 0, this._offset || 0, trans);
  }

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableCollection {
    const filter = convertWhere(field, operator, value, this.allowNonNativeQueries ? 'preferNative' : 'nativeOnly');
    const other = new QueryableFirestoreCollection(this);
    if (typeof filter === 'function') {
      other.manualFilters.push(filter);
    } else {
      other.query = this.query.where(filter.field, filter.operator, filter.value);
    }
    return other;
  }

  whereAny(filters: ManualFilter[]): QueryableCollection {
    if (!this.allowNonNativeQueries) {
      throw new Error('Search is not natively supported by Firestore. Use the `allowNonNativeQueries` option to enable manual search.');
    }
    const other = new QueryableFirestoreCollection(this);
    other.manualFilters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: "desc" | "asc" = 'asc'): QueryableCollection {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.orderBy(field, directionStr);
    return other;
  }

  limit(limit: number): QueryableCollection {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.limit(limit);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableCollection {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.offset(offset);
    return other;
  }
}



async function manualQuery(baseQuery: Query, manualFilters: ManualFilter[], limit: number, offset: number, transaction: Transaction | undefined): Promise<QuerySnapshot> {

  let cursor: QueryDocumentSnapshot | undefined
  let docs: Snapshot[] = [];
  while (!limit || (docs.length < limit)) {
    if (limit) {
      // Use a minimum limit of 10 for the native query
      // E.g. if we only want 1 result, we will still query
      // ten at a time to improve performance
      // But it will increase read usage (at most 9 reads will be unused)
      baseQuery = baseQuery.limit(Math.max(10, limit));
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
      resultDocs = resultDocs.filter((doc) => manualFilters.every(op => op(doc)));
    }

    if (offset > 0) {
      const length = resultDocs.length;
      resultDocs = resultDocs.slice(offset);
      offset -= length;
    }

    if (limit && ((docs.length + resultDocs.length) > limit)) {
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
