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

  constructor(other: DocumentReference<T> | QueryableFlatCollection<T>) {
    if (other instanceof QueryableFlatCollection) {
      this.doc = other.doc;
      // Copy the values
      this._filters = other._filters.slice();
      this._orderBy = other._orderBy.slice();
      this._limit = other._limit;
      this._offset = other._offset;
    } else {
      this.doc = other;

      // Default sort by ID
      this.orderBy(FieldPath.documentId(), 'asc');
    }
  }

  get path(): string {
    return this.doc.parent.path;
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

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableCollection<T> {
    const other = new QueryableFlatCollection(this);

    const filter = convertWhere(field, operator, value, 'manualOnly');
    other._filters.push(filter);
    return other;
  }

  whereAny(filters: ManualFilter[]): QueryableCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._filters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryableCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._orderBy.push({ field, directionStr });
    return other;
  }

  limit(limit: number): QueryableCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._offset = offset;
    return other;
  }
}
