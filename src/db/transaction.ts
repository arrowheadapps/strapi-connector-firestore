import * as _ from 'lodash';
import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Firestore, DocumentSnapshot, FirestoreDataConverter } from '@google-cloud/firestore';
import { DeepReference, makeDeepSnap, mapToFlattenedDoc } from './deep-reference';
import { ReadRepository, RefAndMask } from '../utils/read-repository';
import type { Queryable, QuerySnapshot } from './queryable-collection';
import { Reference, SetOpts, Snapshot } from './reference';
import { MorphReference } from './morph-reference';
import { makeNormalSnap, NormalReference } from './normal-reference';
import { runUpdateLifecycle } from '../utils/lifecycle';

export interface GetOpts {
  /**
   * Relevant in flattened collections only (when getting a `DeepReference`),
   * ignored for normal collections.
   * 
   * If `true`, field masks will be applied so that only the requested entries in the flattened collection
   * are returned, saving bandwidth and processing, but the entries will not be cached in the transaction.
   * 
   * If `false`, the entire flattened collection (stored in a single document) will be
   * fetched and cached in the transaction, meaning to only a single read operation
   * is used even when multiple entries are fetched (in the same transaction).
   * 
   * **Caution:** Use this only when you know that this is the request that will
   * be fetched from this collection within the scope of the transaction. Otherwise you
   * may be defeating the purpose of flattened collections.
   */
  isSingleRequest?: boolean
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
   * The underlying Firestore `Transaction`.
   */
  readonly nativeTransaction: FirestoreTransaction;
  
  /**
   * Reads the given document and holds lock on it
   * for the duration of this transaction.
   * 
   * Returns a cached response if the document has already been
   * fetched and locked using `getAtomic(...)` within this transaction.
   * Does not return a cached response from `getNonAtomic(...)` because
   * that would not establish a lock.
   */
  getAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>

  /**
   * Reads the given document. Returns a cached response if the document
   * has been read *(with `getNonAtomic(...)` or `getAtomic(...)`)* within
   * this transaction.
   */
  getNonAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
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
    readonly nativeTransaction: FirestoreTransaction,
    private readonly logStats: boolean,
    private readonly attempt: number,
  ) {
    
    this.atomicReads = new ReadRepository({
      getAll: (refs, fieldMask) => this.nativeTransaction.getAll(...refs, { fieldMask }),
      getQuery: query => this.nativeTransaction.get(query),
    });

    this.nonAtomicReads = new ReadRepository({
      getAll: (refs, fieldMask) => firestore.getAll(...refs, { fieldMask }),
      getQuery: query => query.get(),
    }, this.atomicReads);
  }

  private async _get(refOrQuery: Reference<any> | Queryable<any>, repo: ReadRepository, opts: GetOpts | undefined): Promise<Snapshot<any> | QuerySnapshot<any>> {
    if (refOrQuery instanceof Reference) {
      return (await this._getAll([refOrQuery], repo, opts))[0];
    } else {
      // Queryable
      return await refOrQuery.get(repo);
    }
    
  }


  private async _getAll(refs: Reference<any>[], repo: ReadRepository, opts: GetOpts | undefined): Promise<Snapshot<any>[]> {
    const isSingleRequest = opts && opts.isSingleRequest;

    // Collect the masks for each native document
    const mapping = new Array(refs.length);
    const docRefs = new Map<string, RefAndMask & { i: number }>();
    for (let i = 0; i < refs.length; i++) {
      const { docRef, deepRef } = getRefInfo(refs[i]);
      let entry = docRefs.get(docRef.path);
      if (!entry) {
        entry = { ref: docRef, i: docRefs.size };
        docRefs.set(docRef.path, entry);
      }
      if (isSingleRequest && deepRef) {
        if (!entry.fieldMasks) {
          entry.fieldMasks = [deepRef.id];
        } else if (!entry.fieldMasks.includes(deepRef.id)) {
          entry.fieldMasks.push(deepRef.id);
        }
      }

      mapping[i] = entry.i;
    }

    const refsWithMasks = Array.from(docRefs.values());
    const results = await repo.getAll(refsWithMasks);
    
    return refs.map((ref, i) => makeSnap(ref, results[mapping[i]]));
  }
  
  getAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>, opts?: GetOpts): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return this._getAll(refOrQuery, this.atomicReads, opts);
    }  else {
      return this._get(refOrQuery, this.atomicReads, opts);
    }
  }
  
  getNonAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getNonAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getNonAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>, opts?: GetOpts): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return this._getAll(refOrQuery, this.nonAtomicReads, opts);
    } else {
      return this._get(refOrQuery, this.nonAtomicReads, opts);
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
        this.nativeTransaction.delete(op.ref)
      } else {
        if (op.create) {
          this.nativeTransaction.create(op.ref, op.data);
        } else {
          // Firestore does not run the converter on update operations
          op.data = op.converter.toFirestore(op.data);
          this.nativeTransaction.update(op.ref, op.data);
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

    const { docRef, deepRef } = getRefInfo(ref);
    const { path } = docRef;

    let op: WriteOp;
    if (this.writes.has(path)) {
      op = this.writes.get(path)!;
    } else {
      op = {
        ref: docRef,
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


interface WriteOp {
  ref: DocumentReference
  data: DocumentData | null
  create: boolean
  converter: FirestoreDataConverter<any>
}

interface RefInfo {
  docRef: DocumentReference<any>,
  deepRef?: DeepReference<any>,
  morphRef?: MorphReference<any>,
}

function getRefInfo(ref: Reference<any>): RefInfo {
  if (ref instanceof NormalReference) {
    return { docRef: ref.ref };
  }
  if (ref instanceof DeepReference) {
    return { docRef: ref.doc, deepRef: ref };
  }
  if (ref instanceof MorphReference) {
    return {
      ...getRefInfo(ref.ref),
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
