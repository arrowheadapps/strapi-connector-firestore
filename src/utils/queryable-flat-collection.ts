import * as _ from 'lodash';
import { getFieldPath, convertWhere, ManualFilter } from './convert-where';
import { DocumentReference, OrderByDirection, Transaction, FieldPath, WhereFilterOp, DocumentData } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { StrapiWhereOperator } from '../types';
import { DeepReference } from './deep-reference';


export class QueryableFlatCollection<T = DocumentData> implements QueryableCollection<T> {

  private readonly doc: DocumentReference<T>
  private _filters: ManualFilter[] = [];
  private _orderBy: { field: string | FieldPath, directionStr: OrderByDirection }[] = [];
  private _limit?: number
  private _offset?: number

  constructor(doc: DocumentReference<T>)
  constructor(other: QueryableFlatCollection<T>)
  constructor(docOrOther: DocumentReference<T> | QueryableFlatCollection<T>) {
    if (docOrOther instanceof QueryableFlatCollection) {
      this.doc = docOrOther.doc;
      // Copy the values
      this._filters = docOrOther._filters.slice();
      this._orderBy = docOrOther._orderBy.slice();
      this._limit = docOrOther._limit;
      this._offset = docOrOther._offset;
    } else {
      this.doc = docOrOther;

      // Default sort by ID
      this.orderBy(FieldPath.documentId(), 'asc');
    }
  }

  async get(trans?: Transaction): Promise<QuerySnapshot<T>> {
    const snap = await (trans ? trans.get(this.doc) : this.doc.get());

    let docs: Snapshot<T>[] = [];
    for (const [id, data] of Object.entries<any>(snap.data() || {})) {
      // Must match every 'AND' filter (if any exist)
      // and at least one 'OR' filter (if any exists)
      const snap: Snapshot<T> = {
        id,
        ref: new DeepReference(this.doc, id),
        exists: data != null,
        data: () => data,
      };
      if (this._filters.every(f => f(snap))) {
        docs.push(snap);
      }
    };

    if (this._orderBy.length) {
      this._orderBy.forEach(({ field, directionStr }) => {
        docs = _.sortBy(docs, d => getFieldPath(field, d));
        if (directionStr === 'desc') {
          docs = _.reverse(docs);
        }
      });
      
    }
    
    // Offset and limit after sorting
    const offset = Math.max(this._offset || 0, 0);
    const limit = Math.max(this._limit || 0, 0) || docs.length;
    docs = docs.slice(offset, offset + limit);

    return {
      docs,
      empty: docs.length === 0
    };
  }

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);

    const filter = convertWhere(field, operator, value, 'manualOnly');
    other._filters.push(filter);
    return other;
  }

  whereAny(filters: ManualFilter[]): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._filters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._orderBy.push({ field, directionStr });
    return other;
  }

  limit(limit: number): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._offset = offset;
    return other;
  }
}
