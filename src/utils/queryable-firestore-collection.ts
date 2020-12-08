import * as _ from 'lodash';
import { ManualFilter, convertWhere } from './convert-where';
import { Query, Transaction, QueryDocumentSnapshot, FieldPath, WhereFilterOp, DocumentData } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { StrapiWhereOperator } from '../types';


export class QueryableFirestoreCollection<T = DocumentData> implements QueryableCollection<T> {

  private allowNonNativeQueries: boolean
  private maxQuerySize: number
  private query: Query<T>
  private manualFilters: ManualFilter[] = [];
  private _limit?: number;
  private _offset?: number;

  constructor(other: QueryableFirestoreCollection<T>)
  constructor(other: Query<T>, allowNonNativeQueries: boolean, maxQuerySize: number | undefined)
  constructor(other: Query<T> | QueryableFirestoreCollection<T>, allowNonNativeQueries?: boolean, maxQuerySize?: number) {
    if (other instanceof QueryableFirestoreCollection) {
      this.allowNonNativeQueries = other.allowNonNativeQueries;
      this.maxQuerySize = other.maxQuerySize;
      this.query = other.query;
      this.manualFilters = other.manualFilters.slice();
      this._limit = other._limit;
      this._offset = other._offset;
    } else {
      this.query = other;
      this.allowNonNativeQueries = allowNonNativeQueries || false;
      this.maxQuerySize = maxQuerySize || 0;
      if (this.maxQuerySize < 0) {
        throw new Error("maxQuerySize cannot be less than zero");
      }
    }
  }

  get(trans?: Transaction): Promise<QuerySnapshot<T>> {
    // Ensure the maximum limit is set if no limit has been set yet
    let q: QueryableFirestoreCollection<T> = this;
    if (this.maxQuerySize && (this._limit === undefined)) {
      q = q.limit(this.maxQuerySize);
    }

    if (q.manualFilters.length) {
      // Only use manual implementation when manual filters are present
      return manualQuery(q.query, q.manualFilters, q._limit || 0, q._offset || 0, trans);
    } else {
      return trans ? trans.get(q.query) : q.query.get();
    }
  }

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableFirestoreCollection<T> {
    const filter = convertWhere(field, operator, value, this.allowNonNativeQueries ? 'preferNative' : 'nativeOnly');
    const other = new QueryableFirestoreCollection(this);
    if (typeof filter === 'function') {
      other.manualFilters.push(filter);
    } else {
      other.query = this.query.where(filter.field, filter.operator, filter.value);
    }
    return other;
  }

  whereAny(filters: ManualFilter[]): QueryableFirestoreCollection<T> {
    if (!this.allowNonNativeQueries) {
      throw new Error('Search is not natively supported by Firestore. Use the `allowNonNativeQueries` option to enable manual search.');
    }
    const other = new QueryableFirestoreCollection(this);
    other.manualFilters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: "desc" | "asc" = 'asc'): QueryableFirestoreCollection<T> {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.orderBy(field, directionStr);
    return other;
  }

  limit(limit: number): QueryableFirestoreCollection<T> {
    if (this.maxQuerySize) {
      limit = Math.min(limit, this.maxQuerySize);
    }

    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.limit(limit);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableFirestoreCollection<T> {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.offset(offset);
    return other;
  }
}



async function manualQuery<T>(baseQuery: Query<T>, manualFilters: ManualFilter[], limit: number, offset: number, transaction: Transaction | undefined): Promise<QuerySnapshot<T>> {

  let cursor: QueryDocumentSnapshot<T> | undefined
  let docs: Snapshot<T>[] = [];
  while (!limit || (docs.length < limit)) {
    if (limit) {
      // Use a minimum limit of 10 for the native query
      // E.g. if we only want 1 result, we will still query
      // ten at a time to improve performance
      // But it will increase read usage (at most 9 reads will be unused)
      baseQuery = baseQuery.limit(Math.max(10, limit));
    }
    if (cursor) {
      // WARNING:
      // Usage of a cursor implicitly applies field ordering by document ID
      // and this can cause queries to fail
      // E.g. inequality filters require the first sort field to be the same
      // field as the inequality filter (see issue #29)
      // This scenario only manifests when manual queries are used
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
