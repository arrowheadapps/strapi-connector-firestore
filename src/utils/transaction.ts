import * as _ from 'lodash';
import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Query, Firestore, SetOptions } from '@google-cloud/firestore';
import type { Queryable, Snapshot, QuerySnapshot, Reference } from './queryable-collection';
import { DeepReference } from './deep-reference';
import { mapToFlattenedDoc } from './map-to-flattened-doc';
import { ReadRepository } from './read-repository';

interface WriteOp {
  ref: DocumentReference
  data: DocumentData | null
  create: boolean
}


/**
 * Acts as a conduit for all read and write operations, with the
 * following behaviours: 
 *  - Caches all read operations so that any document is read 
 *    only once within the batch (excludes queries).
 *  - Merges all writes within a single document so that each
 *    document is written only once.
 *  - Performs all writes within an atomic transaction.
 *  - The `getNonAtomic(...)` methods will reuse a cached read
 *    from a `getAtomic(...)` call, but not the other way around. 
 *  - The `getAtomic(...)` functions perform the read operations within
 *    a `Transaction`, which holds a lock on those documents for the 
 *    duration of the transaction.
 */
export interface Transaction {
  
  /**
   * Reads the given document and holds lock on it
   * for the duration of this transaction.
   * 
   * Returns a cached response if the document has already been
   * fetched and locked using `getAtomic(...)` within this transaction.
   * Does not return a cached response from `getNonAtomic(...)` because
   * that would not establish a lock.
   */
  getAtomic<T extends object>(ref: Reference<T>): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[]): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>

  /**
   * Reads the given document. Returns a cached response if the document
   * has been read *(with `getNonAtomic(...)` or `getAtomic(...)`)* within
   * this transaction.
   */
  getNonAtomic<T extends object>(ref: Reference<T>): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[]): Promise<Snapshot<T>[]>
  getNonAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>

  /**
   * Creates the given document, merging the data with any other `create()` or `update()`
   * operations on the document within this transaction.
   */
  create<T extends object>(ref: Reference<T>, data: T): void
  

  /**
   * Updates the given document, merging the data with any other `create()` or `update()`
   * operations on the document within this transaction.
   * 
   * 
   * @deprecated *WARNING:* This method does not behave the same as Firestore's
   * `set()` method. Instead it behaves exactly the same as `update()`, meaning it
   * fails if the document doesn't exist, and it treats fields with dot paths as deep
   * merging.
   */
  set<T extends object>(ref: Reference<T>, data: Partial<T>, options?: SetOptions): void

  /**
   * Updates the given document, merging the data with any other `create()` or `update()`
   * operations on the document within this transaction.
   */
  update<T extends object>(ref: Reference<T>, data: Partial<T>): void

  /**
   * Deletes the given document, overriding all other write operations
   * on the document in this transaction.
   */
  delete<T extends object>(ref: Reference<T>): void

}


export class TransactionImpl implements Transaction {
  
  private readonly writes = new Map<string, WriteOp>();

  private readonly atomicReads: ReadRepository;
  private readonly nonAtomicReads: ReadRepository;



  constructor(firestore: Firestore, private readonly transaction: FirestoreTransaction) {
    
    this.atomicReads = new ReadRepository(null, {
      getAll: (...refs) => this._requireTransaction().getAll(...refs),
      getQuery: query => {
        if (query instanceof Query) {
          return this._requireTransaction().get(query);
        } else {
          return query.get(this._requireTransaction());
        }
      },
    });

    this.nonAtomicReads = new ReadRepository(this.atomicReads, {
      getAll: (...refs) => firestore.getAll(...refs),
      getQuery: query => query.get(),
    });
  }

  private _requireTransaction(): FirestoreTransaction {
    if (!this.transaction) {
      // TODO:
      // Start a transaction
    }
    return this.transaction!;
  }

  private async _get(refOrQuery: Reference<any> | Queryable<any>, repo: ReadRepository): Promise<Snapshot<any> | QuerySnapshot<any>> {
    // Deep reference to flat collection
    if (refOrQuery instanceof DeepReference) {
      const { doc, id } = refOrQuery;
      const flatDoc = await repo.get(doc);
      const data = flatDoc ? flatDoc.data()?.[id] : undefined;
      const snap: Snapshot<any> = {
        exists: data !== undefined,
        data: () => data,
        ref: refOrQuery,
        id
      };
      return snap;
    }

    if (refOrQuery instanceof DocumentReference) {
      return await repo.get(refOrQuery);
    }

    if (refOrQuery instanceof Query) {
      return await repo.getQuery(refOrQuery);
    }
    
    // Queryable
    return await refOrQuery.get(this.transaction);
  }


  private async _getAll(refs: Reference<any>[], repo: ReadRepository): Promise<Snapshot<any>[]> {
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

    const results = await repo.getAll(docs);
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
  
  getAtomic<T extends object>(ref: Reference<T>): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[]): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return this._getAll(refOrQuery, this.atomicReads);
    } else {
      return this._get(refOrQuery, this.atomicReads);
    }
  }
  
  getNonAtomic<T extends object>(ref: Reference<T>): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[]): Promise<Snapshot<T>[]>
  getNonAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getNonAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return this._getAll(refOrQuery, this.nonAtomicReads);
    } else {
      return this._get(refOrQuery, this.nonAtomicReads);
    }
  }

  /**
   * @private
   */
  commit() {
    // strapi.log.debug(`Comitting Firestore transaction: ${this.writes.size} writes, ${this.atomicReads.size + this.nonAtomicReads.size} reads.`);

    this.writes.forEach(op => {
      if (op.data === null) {
        this.transaction.delete(op.ref)
      } else {
        if (op.create) {
          this.transaction.create(op.ref, op.data);
        } else {
          this.transaction.update(op.ref, op.data);
        }
      }
    });
  }


  create<T extends object>(ref: Reference<T>, data: T): void {
    this._mergeData(ref, data, true);
  }
  
  set<T extends object>(ref: Reference<T>, data: Partial<T>, options?: SetOptions): void {
    this._mergeData(ref, data);
  }
  
  update<T extends object>(ref: Reference<T>, data: Partial<T>): void {
    this._mergeData(ref, data);
  }
  
  delete<T extends object>(ref: Reference<T>): void {
    this._mergeData(ref, null);
  }


  private _mergeData(ref: Reference<any>, data: DocumentData | null, isCreating?: boolean) {
    const { path } = ref;
    if (!this.writes.has(path)) {
      const op: WriteOp = {
        ref: (ref instanceof DeepReference) ? ref.doc : ref,
        data: {},
        create: false,
      };
      this.writes.set(path, op);
    }

    const op = this.writes.get(path)!;
    if (op.data === null) {
      // Deletion overrides all other operations
      return;
    }

    op.create = op.create || isCreating || false;
    if (ref instanceof DeepReference) {
      Object.assign(op.data, mapToFlattenedDoc(ref.id, data, true));
    } else {
      if (data === null) {
        op.data = null;
      } else {
        Object.assign(op.data, data);
      }
    }
  }
}
