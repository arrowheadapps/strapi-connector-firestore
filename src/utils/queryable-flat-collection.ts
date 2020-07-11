import * as _ from 'lodash';
import * as path from 'path';
import { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import { getFieldPath, convertWhereManual, ManualFilter } from './convert-where';
import type { DocumentReference, OrderByDirection, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';


export class QueryableFlatCollection implements QueryableCollection {

  private readonly doc: DocumentReference
  private _filters: ManualFilter[] = [];
  private _orderBy: { field: string | FieldPath, directionStr: OrderByDirection }[] = [];
  private _limit?: number
  private _offset?: number

  constructor(other: DocumentReference | QueryableFlatCollection) {
    if (other instanceof QueryableFlatCollection) {
      this.doc = other.doc;
      // Copy the values
      this._filters = other._filters.slice();
      this._orderBy = other._orderBy.slice();
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
      const snap: Snapshot = {
        id,
        ref: path.posix.join(this.doc.path, id),
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

  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableCollection {
    const other = new QueryableFlatCollection(this);

    const { operator: op } = convertWhereManual(field, operator, value);
    other._filters.push(op);
    return other;
  }

  whereAny(filters: ManualFilter[]): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._filters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._orderBy.push({ field, directionStr });
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
