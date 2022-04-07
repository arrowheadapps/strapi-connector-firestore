import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Firestore, DocumentSnapshot, FirestoreDataConverter } from '@google-cloud/firestore';
import { DeepReference, makeDeepSnap, mapToFlattenedDoc } from './deep-reference';
import { ReadRepository, RefAndMask } from '../utils/read-repository';
import type { Queryable, QuerySnapshot } from './collection';
import { Reference, SetOpts, Snapshot } from './reference';
import { MorphReference } from './morph-reference';
import { makeNormalSnap, NormalReference } from './normal-reference';
import { runUpdateLifecycle } from '../utils/lifecycle';
import { VirtualReference } from './virtual-reference';
import type { GetOpts, Transaction } from './transaction';


export class ReadWriteTransaction implements Transaction {
  
  private readonly writes = new Map<string, WriteOp>();
  private readonly nativeWrites: ((trans: FirestoreTransaction) => void)[] = [];

  /**
   * @private
   * @deprecated For internal connector use only
   */
  readonly successHooks: (() => (void | PromiseLike<void>))[] = [];

  private readonly timestamp = new Date();
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
  
  getAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>, opts?: GetOpts): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return getAll(refOrQuery, this.atomicReads, opts);
    }  else {
      return get(refOrQuery, this.atomicReads, opts);
    }
  }
  
  getNonAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getNonAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getNonAtomic<T extends object>(refOrQuery: Reference<T> | Reference<T>[] | Queryable<T>, opts?: GetOpts): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    if (Array.isArray(refOrQuery)) {
      return getAll(refOrQuery, this.nonAtomicReads, opts);
    } else {
      return get(refOrQuery, this.nonAtomicReads, opts);
    }
  }

  /**
   * @private
   * @deprecated For internal connector use only
   */
  async commit() {
    if (this.logStats) {
      strapi.log.debug(`TRANSACTION (attempt #${this.attempt}): ${this.writes.size} writes, ${this.atomicReads.readCount + this.nonAtomicReads.readCount} reads (${this.atomicReads.readCount} atomic).`);
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

    // Commit any native writes
    for (const cb of this.nativeWrites) {
      cb(this.nativeTransaction);
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
      timestamp: this.timestamp,
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
      timestamp: this.timestamp,
    }))!;
  }
  
  async delete<T extends object>(ref: Reference<T>, opts?: SetOpts): Promise<void> {
    await runUpdateLifecycle({
      editMode: 'update',
      ref,
      data: undefined,
      opts,
      transaction: this,
      timestamp: this.timestamp,
    });
  }

  addNativeWrite(cb: (transaction: FirestoreTransaction) => void): void {
    this.nativeWrites.push(cb);
  }


  addSuccessHook(cb: () => (void | PromiseLike<void>)): void {
    this.successHooks.push(cb);
  }
  
  /**
   * Merges a create, update, or delete operation into pending writes for a given
   * reference in this transaction, without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  mergeWriteInternal<T extends object>(ref: Reference<T>, data: Partial<T> | undefined, editMode: 'create' | 'update') {

    const { docRef, deepRef } = getRefInfo(ref);
    if (!docRef) {
      (ref as VirtualReference<T>).writeInternal(data, editMode);
      return;
    }

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
  docRef?: DocumentReference<any>,
  deepRef?: DeepReference<any>,
  morphRef?: MorphReference<any>,
}


export async function get(refOrQuery: Reference<any> | Queryable<any>, repo: ReadRepository, opts: GetOpts | undefined): Promise<Snapshot<any> | QuerySnapshot<any>> {
  if (refOrQuery instanceof Reference) {
    return (await getAll([refOrQuery], repo, opts))[0];
  } else {
    // Queryable
    return await refOrQuery.get(repo);
  }
}


export async function getAll(refs: Reference<any>[], repo: ReadRepository, opts: GetOpts | undefined): Promise<Snapshot<any>[]> {
  const isSingleRequest = opts && opts.isSingleRequest;

  // Collect the masks for each native document
  const getters: ((args: { ref: Reference<any>, results: DocumentSnapshot<any>[], virtualSnaps: Snapshot<any>[] }) => Snapshot<any>)[] = new Array(refs.length);
  const docRefs = new Map<string, RefAndMask & { i: number }>();
  const virtualGets: Promise<Snapshot<any>>[] = [];

  for (let i = 0; i < refs.length; i++) {
    const { docRef, deepRef } = getRefInfo(refs[i]);
    if (!docRef) {
      const index = virtualGets.length;
      const ref = refs[i] as VirtualReference<any>;
      virtualGets.push(ref.get());
      getters[i] = ({ virtualSnaps }) => virtualSnaps[index];
    } else {
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

      getters[i] = ({ ref, results }) => makeSnap(ref, results[entry!.i]);
    }
  }

  const refsWithMasks = Array.from(docRefs.values());
  const virtualSnaps = await Promise.all(virtualGets);
  const results = await repo.getAll(refsWithMasks);
  
  return refs.map((ref, i) => getters[i]({ ref, results, virtualSnaps }));
}

export function getRefInfo(ref: Reference<any>): RefInfo {
  if (ref instanceof NormalReference) {
    return { docRef: ref.ref };
  }
  if (ref instanceof DeepReference) {
    return { docRef: ref.doc, deepRef: ref };
  }
  if (ref instanceof VirtualReference) {
    return {};
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
