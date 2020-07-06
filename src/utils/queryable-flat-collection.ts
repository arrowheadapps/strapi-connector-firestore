import * as _ from 'lodash';
import * as path from 'path';
import { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import { getFieldPath, convertWhereManual, ManualFilter } from './convert-where';
import type { DocumentReference, OrderByDirection, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';


export class QueryableFlatCollection implements QueryableCollection {

  private readonly doc: DocumentReference
  private _filters: ManualFilter[] = [];
  private _orFilters: ManualFilter[] = [];
  private _orderBy?: { field: string | FieldPath, directionStr: OrderByDirection }
  private _limit?: number
  private _offset?: number

  constructor(other: DocumentReference | QueryableFlatCollection) {
    if (other instanceof QueryableFlatCollection) {
      this.doc = other.doc;
      // Copy the values
      this._filters = other._filters.slice();
      this._orderBy = Object.assign({}, other._orderBy);
      this._limit = other._limit;
      this._offset = other._offset;
    } else {
      this.doc = other;
    }
  }

  async get(trans?: Transaction): Promise<QuerySnapshot> {
    const snap = await (trans ? trans.get(this.doc) : this.doc.get());

    let docs: Snapshot[] = [];
    for (const [id, data] of Object.entries(snap.data() || {})) {
      // Must match every 'AND' filter (if any exist)
      // and at least one 'OR' filter (if any exists)
      if ((!this._filters.length || this._filters.every(f => f(data))) && (!this._orFilters || this._orFilters.some(f => f(data)))) {
        docs.push({
          id,
          data: () => data,
          ref: path.posix.join(this.doc.path, id),
          exists: true
        });
      }
    };

    if (this._orderBy) {
      docs = _.sortBy(docs, d => getFieldPath(this._orderBy!.field, d));
      if (this._orderBy!.directionStr === 'desc') {
        docs = _.reverse(docs);
      }
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

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, combinator: 'and' | 'or' = 'and'): QueryableCollection {
    const other = new QueryableFlatCollection(this);

    const { operator: op } = convertWhereManual(field, operator, value);
    if (combinator === 'or') {
      other._orFilters.push(op);
    } else {
      other._filters.push(op);
    }

    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._orderBy = { field, directionStr };
    return other;
  }

  limit(limit: number): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._offset = offset;
    return other;
  }
}
