import * as _ from 'lodash';
import { DocumentReference, DocumentSnapshot, Transaction, DocumentData, Firestore, Query } from '@google-cloud/firestore';
import type { QueryableCollection, Snapshot, QuerySnapshot, Reference } from './queryable-collection';
import { parseDeepReference, parseRef } from './doc-ref';

export class TransactionWrapper {
  private readonly transaction: Transaction
  private readonly writes: ((trans: Transaction) => void)[] = [];

  private readonly keyedContext: Record<string, DocumentData> = {};
  private readonly docReads: Record<string, Promise<DocumentSnapshot>> = {};

  constructor(transaction: Transaction, private readonly instance: Firestore) {
    this.transaction = transaction;
    this.instance = instance;
  }

  /**
   * Gets all DocumentReferences and memoises the promises to the results of each.
   * Only those that aren't already memoised are actually fetched.
   * Any duplicate documents are only actually fetched once.
   */
  private _getAll(docs: DocumentReference[]): Promise<DocumentSnapshot[]> {

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
    const results = docs.map(({ path }) => this.docReads[path]);
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


  get(documentRef: Reference): Promise<Snapshot>;
  get(query: QueryableCollection): Promise<QuerySnapshot>;
  async get(val: Reference | QueryableCollection): Promise<any> {
    // Deep reference to flat collection
    if (typeof val === 'string') {
      const { doc, id } = parseDeepReference(val, this.instance);
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
      return await this.transaction.get(val);
    }

    if (val instanceof Query) {
      return await this.transaction.get(val);
    }
    
    // Queryable collection
    return await val.get(this.transaction);

  }

  async getAll(...refs: Reference[]): Promise<Snapshot[]> {
    const docs: DocumentReference[] = new Array(refs.length);
    const ids: (string | null)[] = new Array(refs.length);
    refs.forEach((ref, i) => {
      const r = parseRef(ref, this.instance);
      if (r instanceof DocumentReference) {
        docs[i] = r;
        ids[i] = null;
      } else {
        docs[i] = r.doc;
        ids[i] = r.id;
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

  doWrites() {
    this.writes.forEach(w => w(this.transaction));
  }
}