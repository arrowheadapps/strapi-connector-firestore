import * as _ from 'lodash';
import * as path from 'path';
import { QueryableCollection, QuerySnapshot, Snapshot } from "./queryable-collection";
import type { DocumentReference, DocumentData, OrderByDirection, Transaction, WhereFilterOp } from "@google-cloud/firestore";


export class QueryableFlatCollection implements QueryableCollection {

  private readonly doc: DocumentReference
  private _filters: ((data: DocumentData) => boolean)[] = [];
  private _orderBy?: { fieldPath: string, directionStr: OrderByDirection }
  private _limit?: number
  private _offset?: number

  constructor(other: DocumentReference | QueryableFlatCollection) {
    if (other instanceof QueryableFlatCollection) {
      this.doc = other.doc;
      this._filters = other._filters;
    } else {
      this.doc = other;
    }
  }

  async get(trans?: Transaction): Promise<QuerySnapshot> {
    const snap = await (trans ? trans.get(this.doc) : this.doc.get());

    let docs: Snapshot[] = [];
    for (const [id, data] of Object.entries(snap.data() || {})) {
      if (this._filters.every(f => f(data))) {
        docs.push({
          id,
          data: () => data,
          ref: path.posix.join(this.doc.path, id),
          exists: true
        });
      }
    };

    if (this._orderBy) {
      docs = _.sortBy(docs, d => _.get(d, this._orderBy!.fieldPath));
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

  where(fieldPath: string, opStr: WhereFilterOp, value: any): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._filters.push();

    throw new Error("Method not implemented.");
  }

  orderBy(fieldPath: string, directionStr: OrderByDirection = 'asc'): QueryableCollection {
    const other = new QueryableFlatCollection(this);
    other._orderBy = { fieldPath, directionStr };
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

  search(query: string): QueryableCollection {
    throw new Error("Method not implemented.");
  }


}
