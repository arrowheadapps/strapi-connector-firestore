import * as _ from 'lodash';
import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Query, Firestore, SetOptions, FirestoreDataConverter } from '@google-cloud/firestore';
import { DeepReference } from './deep-reference';
import { makeFlattenedSnap, mapToFlattenedDoc } from './flattened-doc';
import { ReadRepository } from './read-repository';
import { MorphReference } from './morph-reference';
import type { FirestoreConnectorModel } from '../model';
import type { Queryable, Snapshot, QuerySnapshot, Reference } from './queryable-collection';

interface WriteOp {
  ref: DocumentReference
  data: DocumentData | null
  create: boolean
  conv: FirestoreDataConverter<any>
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
  private readonly ensureFlatCollections: Promise<void>[] = [];


  constructor(
    firestore: Firestore,
    private readonly transaction: FirestoreTransaction,
    private readonly logStats: boolean,
    private readonly attempt: number,
  ) {
    
    this.atomicReads = new ReadRepository(null, {
      getAll: (...refs) => this.transaction.getAll(...refs),
      getQuery: query => {
        if (query instanceof Query) {
          return this.transaction.get(query);
        } else {
          return query.get(this.transaction);
        }
      },
    });

    this.nonAtomicReads = new ReadRepository(this.atomicReads, {
      getAll: (...refs) => firestore.getAll(...refs),
      getQuery: query => query.get(),
    });
  }

  private async _get(refOrQuery: Reference<any> | Queryable<any>, repo: ReadRepository): Promise<Snapshot<any> | QuerySnapshot<any>> {
    if ((refOrQuery instanceof DocumentReference)
      || (refOrQuery instanceof DeepReference)
      || (refOrQuery instanceof MorphReference)) {
      return (await this._getAll([refOrQuery], repo))[0];
    }
    
    // Queryable
    return await refOrQuery.get(this.transaction);
  }


  private async _getAll(refs: Reference<any>[], repo: ReadRepository): Promise<Snapshot<any>[]> {
    const docs: DocumentReference[] = new Array(refs.length);
    const deep: (DeepReference<any> | undefined)[] = new Array(refs.length);
    refs.forEach((r, i) => {
      const { ref, deepRef } = getDocRef(r);
      docs[i] = ref;
      deep[i] = deepRef;
    });

    const results = await repo.getAll(docs);
    return results.map((s, i) => {
      const deepRef = deep[i];
      const snap = deepRef ? makeFlattenedSnap(deepRef, s) : s;
      return {
        id: snap.id,
        ref: snap.ref,
        exists: snap.exists,
        data: () => snap.data(),
      };
    });
  }
  
  getAtomic<T extends object>(ref: Reference<T>): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[]): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return this._getAll(refOrQuery, this.atomicReads);
    }  else {
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
  async commit() {
    if (this.logStats) {
      strapi.log.debug(`TRANSACTION (attempt #${this.attempt}): ${this.writes.size} writes, ${this.atomicReads.size + this.nonAtomicReads.size} reads (${this.atomicReads.size} atomic).`);
    }

    // If we have fetched flat documents then we need to wait to
    // ensure that the document exists so that the update
    // operate will succeed
    await Promise.all(this.ensureFlatCollections);

    for (const op of this.writes.values()) {
      if (op.data === null) {
        this.transaction.delete(op.ref)
      } else {
        if (op.create) {
          this.transaction.create(op.ref, op.data);
        } else {
          // Firestore does not run the converter 
          // on update operations
          op.data = op.conv.toFirestore(op.data);
          this.transaction.update(op.ref, op.data);
        }
      }
    }
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
    const { deepRef, ref: rootRef } = getDocRef(ref);
    const { path } = rootRef;

    if (!this.writes.has(path)) {
      const op: WriteOp = {
        ref: rootRef,
        data: {},
        create: false,
        conv: getModelByRef(ref).db.converter,
      };
      this.writes.set(path, op);

      // If the write is for a flattened collection
      // then pre-emptively start ensuring that the document exists
      if (deepRef) {
        this.ensureFlatCollections.push(deepRef.parent.ensureDocument());
      }
    }

    const op = this.writes.get(path)!;
    if (op.data === null) {
      // Deletion overrides all other operations
      return;
    }

    // Don't create documents for flattened collections
    // because we use ensureDocument() and then update()
    op.create = op.create || (isCreating && !deepRef) || false;

    if (deepRef) {
      Object.assign(op.data, mapToFlattenedDoc(deepRef, data, true));
    } else {
      if (data === null) {
        op.data = null;
      } else {
        Object.assign(op.data, data);
      }
    }
  }
}

interface RefInfo {
  ref: DocumentReference<any>,
  deepRef?: DeepReference<any>,
}

function getDocRef(ref: Reference<any>): RefInfo {
  if (ref instanceof DeepReference) {
    return { ref: ref.doc, deepRef: ref };
  }
  if (ref instanceof MorphReference) {
    return getDocRef(ref.ref);
  }
  return { ref };
}

function getModelByRef({ parent: { path } }: Reference<any>): FirestoreConnectorModel<any> {
  const model = strapi.db.getModelByCollectionName(path);
  if (!model) {
    throw new Error(`Model for path "${path}" not found`);
  }
  return model;
}
