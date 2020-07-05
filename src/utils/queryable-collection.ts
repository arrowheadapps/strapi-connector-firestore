import * as _ from 'lodash';
import * as path from 'path';
import type { WhereFilterOp, OrderByDirection, DocumentData, DocumentReference, Firestore, Transaction } from '@google-cloud/firestore';

export type Reference = DocumentReference | DeepReference;

/**
 * References a field within a document.
 * In the format: "collection/doc/field"
 */
export type DeepReference = string;

export function parseDeepReference(ref: DeepReference, instance: Firestore) {

  const lastSlash = ref.lastIndexOf('/');
  const id = ref.slice(lastSlash + 1);
  if ((lastSlash === -1) || !id) {
    throw new Error('Reference has invalid format');
  }

  const doc = instance.doc(ref.slice(0, lastSlash));

  return {
    doc,
    id,
    path: doc.path
  }
}


export interface Snapshot {
  data(): DocumentData
  ref: Reference
  id: string
  exists: boolean
}

export interface QuerySnapshot {
  docs: Snapshot[]
  empty: boolean
}


export interface QueryableCollection {
  get(): Promise<QuerySnapshot>;
  
  where(fieldPath: string, opStr: WhereFilterOp, value: any): QueryableCollection;
  orderBy(fieldPath: string, directionStr?: OrderByDirection): QueryableCollection;
  limit(limit: number): QueryableCollection;
  offset(offset: number): QueryableCollection;
  startAfter(ref: Snapshot): QueryableCollection;
}

export class FlatCollection implements QueryableCollection {

  private readonly doc: DocumentReference
  private _filters: ((data: DocumentData) => boolean)[] = [];
  private _orderBy?: { fieldPath: string, directionStr: OrderByDirection }
  private _limit?: number
  private _offset?: number

  constructor(other: DocumentReference | FlatCollection) {
    if (other instanceof FlatCollection) {
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
    const other = new FlatCollection(this);
    other._filters.push();

    throw new Error("Method not implemented.");
  }

  orderBy(fieldPath: string, directionStr: OrderByDirection = 'asc'): QueryableCollection {
    const other = new FlatCollection(this);
    other._orderBy = { fieldPath, directionStr };
    return other;
  }

  limit(limit: number): QueryableCollection {
    const other = new FlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableCollection {
    const other = new FlatCollection(this);
    other._offset = offset;
    return other;
  }

  startAfter(ref: Snapshot): QueryableCollection {
    // TODO
    throw new Error("Method not implemented.");
  }


}
