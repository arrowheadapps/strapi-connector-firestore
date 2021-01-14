import * as _ from 'lodash';
import { ManualFilter, convertWhere, WhereFilter } from './convert-where';
import { Query, Transaction, QueryDocumentSnapshot, FieldPath, WhereFilterOp, DocumentData, CollectionReference, FirestoreDataConverter, DocumentReference } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { StrapiWhereFilter, StrapiWhereOperator } from '../types';
import { coerceModelFromFirestore, coerceModelToFirestore } from './coerce';
import type { FirestoreConnectorModel } from '../model';


export class QueryableFirestoreCollection<T extends object = DocumentData> implements QueryableCollection<T> {

  private readonly model: FirestoreConnectorModel<T>
  private readonly collection: CollectionReference<T>
  readonly converter: FirestoreDataConverter<T>;
  
  private readonly allowNonNativeQueries: boolean
  private readonly maxQuerySize: number
  private query: Query<T>
  private readonly manualFilters: ManualFilter[] = [];
  private _limit?: number;
  private _offset?: number;

  constructor(other: QueryableFirestoreCollection<T>)
  constructor(model: FirestoreConnectorModel<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | QueryableFirestoreCollection<T>) {
    if (modelOrOther instanceof QueryableFirestoreCollection) {
      this.model = modelOrOther.model;
      this.collection = modelOrOther.collection;
      this.converter = modelOrOther.converter;
      this.allowNonNativeQueries = modelOrOther.allowNonNativeQueries;
      this.maxQuerySize = modelOrOther.maxQuerySize;
      this.query = modelOrOther.query;
      this.manualFilters = modelOrOther.manualFilters.slice();
      this._limit = modelOrOther._limit;
      this._offset = modelOrOther._offset;
    } else {
      
      this.model = modelOrOther;
      const {
        toFirestore = (value) => value,
        fromFirestore = (value) => value,
      } = modelOrOther.options.converter;
      this.converter = {
        toFirestore: data => toFirestore(coerceModelToFirestore(modelOrOther, data)),
        fromFirestore: snap => coerceModelFromFirestore(modelOrOther, snap.id, fromFirestore(snap.data())),
      };

      this.collection = modelOrOther.firestore
        .collection(modelOrOther.collectionName)
        .withConverter(this.converter);

      this.query = this.collection;
      this.allowNonNativeQueries = modelOrOther.options.allowNonNativeQueries;
      this.maxQuerySize = modelOrOther.options.maxQuerySize;
      
      if (this.maxQuerySize < 0) {
        throw new Error("maxQuerySize cannot be less than zero");
      }
    }
  }


  
  get path() {
    return this.collection.path;
  }

  autoId() {
    return this.collection.doc().id;
  }

  doc(): DocumentReference<T>;
  doc(id: string): DocumentReference<T>;
  doc(id?: string) {
    return id ? this.collection.doc(id.toString()) : this.collection.doc();
  }


  private warnQueryLimit(limit: number | 'unlimited') {
    const msg = 
      `The query limit of "${limit}" has been capped to "${this.maxQuerySize}".` +
      'Adjust the strapi-connector-firestore \`maxQuerySize\` configuration option ' +
      'if this is not the desired behaviour.';

    if (limit === 'unlimited') {
      // Log at debug level if no limit was set
      strapi.log.debug(msg);
    } else {
      // Log at warning level if a limit was explicitly
      // set beyond the maximum limit
      strapi.log.warn(msg);
    }
  }

  get(trans?: Transaction): Promise<QuerySnapshot<T>> {
    // Ensure the maximum limit is set if no limit has been set yet
    let q: QueryableFirestoreCollection<T> = this;
    if (this.maxQuerySize && (this._limit === undefined)) {
      // Log a warning when the limit is applied where no limit was requested
      this.warnQueryLimit('unlimited');
      q = q.limit(this.maxQuerySize);
    }

    if (q.manualFilters.length) {
      // Only use manual implementation when manual filters are present
      return queryWithManualFilters(q.query, q.manualFilters, q._limit || 0, q._offset || 0, trans);
    } else {
      return trans ? trans.get(q.query) : q.query.get();
    }
  }

  where(filter: StrapiWhereFilter | WhereFilter): QueryableFirestoreCollection<T>
  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any): QueryableFirestoreCollection<T>
  where(fieldOrFilter: string | FieldPath | StrapiWhereFilter | WhereFilter, operator?: WhereFilterOp | StrapiWhereOperator, value?: any): QueryableFirestoreCollection<T> {
    if ((typeof fieldOrFilter === 'string') || (fieldOrFilter instanceof FieldPath)) {
      const filter = convertWhere(this.model, fieldOrFilter, operator!, value, this.allowNonNativeQueries ? 'preferNative' : 'nativeOnly');
      const other = new QueryableFirestoreCollection(this);
      if (typeof filter === 'function') {
        other.manualFilters.push(filter);
      } else {
        other.query = this.query.where(filter.field, filter.operator, filter.value);
      }
      return other;
    } else {
      return this.where(fieldOrFilter.field, fieldOrFilter.operator, fieldOrFilter.value);
    }
  }

  whereAny(filters: (StrapiWhereFilter | WhereFilter)[]): QueryableFirestoreCollection<T> {
    if (!this.allowNonNativeQueries) {
      throw new Error('OR filters and search are not natively supported by Firestore. Use the `allowNonNativeQueries` option to enable manual search, or `searchAttribute` to enable primitive search.');
    }
    const other = new QueryableFirestoreCollection(this);
    const filterFns = filters.map(({ field, operator, value }) => {
      return convertWhere(this.model, field, operator, value, 'manualOnly');
    });
    other.manualFilters.push(data => filterFns.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: "desc" | "asc" = 'asc'): QueryableFirestoreCollection<T> {
    const other = new QueryableFirestoreCollection(this);
    other.query = this.query.orderBy(field, directionStr);
    return other;
  }

  limit(limit: number): QueryableFirestoreCollection<T> {
    if (this.maxQuerySize && (this.maxQuerySize < limit)) {
      // Log a warning when a limit is explicitly requested larger
      // than than the configured limit
      this.warnQueryLimit(limit);
      limit = this.maxQuerySize;
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


async function* queryChunked<T extends object>(query: Query<T>, chunkSize:number, transaction: Transaction | undefined) {
  let cursor: QueryDocumentSnapshot<T> | undefined
  while (true) {
    let q = query.limit(chunkSize);
    if (cursor) {
      // WARNING:
      // Usage of a cursor implicitly applies field ordering by document ID
      // and this can cause queries to fail
      // E.g. inequality filters require the first sort field to be the same
      // field as the inequality filter (see issue #29)
      // This scenario only manifests when manual queries are used
      q = q.startAfter(cursor);
    }

    const { docs } = await (transaction ? transaction.get(q) : q.get());
    cursor = docs[docs.length - 1];

    for (const d of docs) {
      yield d;
    }

    if (docs.length < chunkSize) {
      return;
    }
  }
}

async function queryWithManualFilters<T extends object>(query: Query<T>, filters: ManualFilter[], limit: number, offset: number, transaction: Transaction | undefined): Promise<QuerySnapshot<T>> {

  // Use a chunk size of 10 for the native query
  // E.g. if we only want 1 result, we will still query
  // ten at a time to improve performance for larger queries
  // But it will increase read usage (at most 9 reads will be unused)
  const chunkSize = Math.max(10, limit);

  // Improve performace by performing some native offset
  const q = query.offset(offset);

  const docs: Snapshot<T>[] = [];
  let skipped = 0;

  for await (const doc of queryChunked(q, chunkSize, transaction)) {
    if (filters.every(op => op(doc))) {
      if (limit > skipped) {
        skipped++;
      } else {
        docs.push(doc);
        if (docs.length >= limit) {
          break;
        }
      }
    }
  }

  return {
    docs,
    empty: docs.length === 0,
  };
}