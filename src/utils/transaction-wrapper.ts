import * as _ from 'lodash';
import { DocumentReference, DocumentSnapshot, Transaction, DocumentData, Query } from '@google-cloud/firestore';
import type { Queryable, Snapshot, QuerySnapshot, Reference } from './queryable-collection';
import { DeepReference } from './deep-reference';

export interface TransactionWrapper {

  get<T>(documentRef: Reference<T>): Promise<Snapshot<T>>;
  get<T>(query: Queryable<T>): Promise<QuerySnapshot<T>>;
  getAll<T>(...refs: Reference<T>[]): Promise<Snapshot<T>[]>;

  addWrite(writeOp: (trans: Transaction) => void): void;
  addWrites(writeOps: ((trans: Transaction) => void)[]): void;
}

export class TransactionWrapperImpl implements TransactionWrapper {
  private readonly transaction: Transaction
  private readonly writes: ((trans: Transaction) => void)[] = [];

  private readonly keyedContext: Record<string, DocumentData> = {};
  private readonly docReads: Record<string, Promise<DocumentSnapshot>> = {};

  constructor(transaction: Transaction) {
    this.transaction = transaction;
  }

  /**
   * Gets all DocumentReferences and memoises the promises to the results of each.
   * Only those that aren't already memoised are actually fetched.
   * Any duplicate documents are only actually fetched once.
   */
  private _getAll<T = DocumentData>(docs: DocumentReference<T>[]): Promise<DocumentSnapshot<T>[]> {

    // Unique documents that haven't already been fetched
    const toGet = _.uniqBy(docs.filter(({ path }) => !this.docReads[path]), doc => doc.path);

    // Memoise a promise for each document
    const toGetAsync = toGet.length 
      ? this.transaction.getAll(...toGet) 
      : Promise.resolve([]);
    toGet.forEach(({ path }, i) => {
      this.docReads[path] = toGetAsync.then(snaps => snaps[i]);
    });

    // Arrange all the memoised promises as results
    const results = docs.map(({ path }) => this.docReads[path] as Promise<DocumentSnapshot<T>>);
    return Promise.all(results);
  }

  /**
   * Get's a single DocumentReference and memoises the result.
   * Returns a memoised result if there is one.
   */
  private _get(doc: DocumentReference): Promise<DocumentSnapshot> {
    if (!this.docReads[doc.path]) {
      this.docReads[doc.path] = this.transaction.get(doc);
    }
    return this.docReads[doc.path];
  }


  get<T>(documentRef: Reference<T>): Promise<Snapshot<T>>;
  get<T>(query: Queryable<T>): Promise<QuerySnapshot<T>>;
  async get(val: Reference | Queryable): Promise<any> {
    // Deep reference to flat collection
    if (val instanceof DeepReference) {
      const { doc, id } = val;
      const flatDoc = await this._get(doc);
      const data = flatDoc.data()?.[id];
      const snap: Snapshot = {
        exists: data !== undefined,
        data: () => data,
        ref: val,
        id
      };
      return snap;
    }

    if (val instanceof DocumentReference) {
      return await this._get(val);
    }

    if (val instanceof Query) {
      return await this.transaction.get(val);
    }
    
    // Queryable
    return await val.get(this.transaction);

  }

  async getAll(...refs: Reference<any>[]): Promise<Snapshot<any>[]> {
    const docs: DocumentReference<any>[] = new Array(refs.length);
    const ids: (string | null)[] = new Array(refs.length);
    refs.forEach((ref, i) => {
      if (ref instanceof DocumentReference) {
        docs[i] = ref;
        ids[i] = null;
      } else {
        docs[i] = ref.doc;
        ids[i] = ref.id;
      }
    });

    const results = await this._getAll(docs);
    return results.map((snap, i) => {
      const id = ids[i];
      if (id) {
        const data = snap.data()?.[id];
        return {
          ref: refs[i],
          data: () => data,
          exists: data !== undefined,
          id
        };
      } else {
        return snap;
      }
    });
  }

  addWrite(writeOp: (trans: Transaction) => void) {
    this.writes.push(writeOp);
  }

  addWrites(writeOps: ((trans: Transaction) => void)[]) {
    this.writes.push(...writeOps);
  }

  addKeyedWrite(key: string, updateOp: (context: DocumentData | undefined) => DocumentData, writeOp: (trans: Transaction, context: DocumentData) => void) {
    if (!this.keyedContext[key]) {
      // Update the context and add the write op
      this.keyedContext[key] = updateOp(undefined);
      this.writes.push((trans) => writeOp(trans, this.keyedContext[key]));
    } else {
      // Write op is already added
      // Just update the context
      this.keyedContext[key] = updateOp(undefined);
    }
  }

  /**
   * @private
   */
  doWrites() {
    this.writes.forEach(w => w(this.transaction));
  }
}