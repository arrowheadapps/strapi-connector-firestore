import * as _ from 'lodash';
import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Firestore, DocumentSnapshot, FirestoreDataConverter } from '@google-cloud/firestore';
import { DeepReference, makeDeepSnap, mapToFlattenedDoc } from './deep-reference';
import { ReadRepository } from '../utils/read-repository';
import type { Queryable, QuerySnapshot } from './queryable-collection';
import { Reference, SetOpts, Snapshot } from './reference';
import { MorphReference } from './morph-reference';
import { makeNormalSnap, NormalReference } from './normal-reference';
import { runUpdateLifecycle } from '../utils/lifecycle';

export interface WriteOp {
  ref: DocumentReference
  data: DocumentData | null
  create: boolean
  converter: FirestoreDataConverter<any>
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
   * 
   * @returns The coerced data
   */
  create<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  create<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  
  /**
   * Updates the given document, merging the data with any other `create()` or `update()`
   * operations on the document within this transaction.
   * 
   * @returns The coerced data
   */
  update<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<T>
  update<T extends object>(ref: Reference<T>, data: Partial<Partial<T>>, opts?: SetOpts): Promise<Partial<T>>

  /**
   * Deletes the given document, overriding all other write operations
   * on the document in this transaction.
   */
  delete<T extends object>(ref: Reference<T>, opts?: SetOpts): Promise<void>

}


export class TransactionImpl implements Transaction {
  
  private readonly writes = new Map<string, WriteOp>();

  private readonly atomicReads: ReadRepository;
  private readonly nonAtomicReads: ReadRepository;
  private readonly ensureFlatCollections: Promise<void>[] = [];


  constructor(
    readonly firestore: Firestore,
    readonly transaction: FirestoreTransaction,
    private readonly logStats: boolean,
    private readonly attempt: number,
  ) {
    
    this.atomicReads = new ReadRepository(null, {
      getAll: (...refs) => this.transaction.getAll(...refs),
      getQuery: query => this.transaction.get(query),
    });

    this.nonAtomicReads = new ReadRepository(this.atomicReads, {
      getAll: (...refs) => firestore.getAll(...refs),
      getQuery: query => query.get(),
    });
  }

  private async _get(refOrQuery: Reference<any> | Queryable<any>, repo: ReadRepository): Promise<Snapshot<any> | QuerySnapshot<any>> {
    if (refOrQuery instanceof Reference) {
      return (await this._getAll([refOrQuery], repo))[0];
    } else {
      // Queryable
      return await refOrQuery.get(repo);
    }
    
  }


  private async _getAll(refs: Reference<any>[], repo: ReadRepository): Promise<Snapshot<any>[]> {
    const results = await repo.getAll(refs.map(r => getDocRef(r).ref));
    return refs.map((ref, i) => makeSnap(ref, results[i]));
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
   * @deprecated For internal connector use only
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
          // Firestore does not run the converter on update operations
          op.data = op.converter.toFirestore(op.data);
          this.transaction.update(op.ref, op.data);
        }
      }
    }
  }


  create<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  create<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async create<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    return (await runUpdateLifecycle({
      editMode: 'create',
      ref,
      data,
      opts,
      transaction: this,
    }))!;
  }
  
  update<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  update<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async update<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    return (await runUpdateLifecycle({
      editMode: 'update',
      ref,
      data,
      opts,
      transaction: this,
    }))!;
  }
  
  async delete<T extends object>(ref: Reference<T>, opts?: SetOpts): Promise<void> {
    await runUpdateLifecycle({
      editMode: 'update',
      ref,
      data: undefined,
      opts,
      transaction: this,
    });
  }


  
  /**
   * Merges a create, update, or delete operation into pending writes for a given
   * reference in this transaction, without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  mergeWriteInternal<T extends object>(ref: Reference<T>, data: Partial<T> | undefined, editMode: 'create' | 'update') {

    const { ref: rootRef, deepRef } = getDocRef(ref);
    const { path } = rootRef;

    let op: WriteOp;
    if (this.writes.has(path)) {
      op = this.writes.get(path)!;
    } else {
      op = {
        ref: rootRef,
        data: {},
        create: false,
        converter: ref.parent.converter,
      };
      this.writes.set(path, op);

      // If the write is for a flattened collection
      // then pre-emptively start ensuring that the document exists
      if (deepRef) {
        this.ensureFlatCollections.push(deepRef.parent.ensureDocument());
      }
    }

    if (op.data === null) {
      // Deletion overrides all other operations
      return;
    }

    // Don't create documents for flattened collections
    // because we use ensureDocument() and then update()
    op.create = op.create || ((editMode === 'create') && !deepRef) || false;

    if (deepRef) {
      Object.assign(op.data, mapToFlattenedDoc(deepRef, data, true));
    } else {
      if (!data) {
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
  morphRef?: MorphReference<any>,
}

function getDocRef(ref: Reference<any>): RefInfo {
  if (ref instanceof NormalReference) {
    return { ref: ref.ref };
  }
  if (ref instanceof DeepReference) {
    return { ref: ref.doc, deepRef: ref };
  }
  if (ref instanceof MorphReference) {
    return {
      ...getDocRef(ref.ref),
      morphRef: ref,
    };
  }
  throw new Error('Unknown type of reference');
}

function makeSnap(ref: Reference<any>, snap: DocumentSnapshot<any>): Snapshot<any> {
  if (ref instanceof NormalReference) {
    return makeNormalSnap(ref, snap);
  }
  if (ref instanceof DeepReference) {
    return makeDeepSnap(ref, snap);
  }
  if (ref instanceof MorphReference) {
    return {
      ...makeSnap(ref, snap),
      ref,
    }
  }
  throw new Error('Unknown type of reference');
}
