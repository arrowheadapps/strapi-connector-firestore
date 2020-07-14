import { DocumentReference, DocumentSnapshot, Transaction, ReadOptions, DocumentData, Firestore, Query } from '@google-cloud/firestore';
import type { QueryableCollection, Snapshot, QuerySnapshot, Reference } from './queryable-collection';
import { parseDeepReference } from './doc-ref';

export class TransactionWrapper {
  private readonly transaction: Transaction
  private readonly writes: ((trans: Transaction) => void)[] = [];

  private readonly keyedContext: Record<string, DocumentData> = {};

  constructor(transaction: Transaction, private readonly instance: Firestore) {
    this.transaction = transaction;
    this.instance = instance;
  }

  get(documentRef: Reference): Promise<Snapshot>;
  get(query: QueryableCollection): Promise<QuerySnapshot>;
  async get(val: Reference | QueryableCollection): Promise<any> {
    // Deep reference to flat collection
    if (typeof val === 'string') {
      const { doc, id } = parseDeepReference(val, this.instance);
      const flatDoc = await this.transaction.get(doc);
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

  getAll<T>(...documentRefsOrReadOptions: (DocumentReference<T> | ReadOptions)[]): Promise<DocumentSnapshot<T>[]> {
    return this.transaction.getAll<T>(...documentRefsOrReadOptions);
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