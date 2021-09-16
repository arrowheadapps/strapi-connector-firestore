import * as _ from 'lodash';
import { DocumentReference, Transaction as FirestoreTransaction, DocumentData, Firestore, DocumentSnapshot, FirestoreDataConverter } from '@google-cloud/firestore';
import { DeepReference, makeDeepSnap, mapToFlattenedDoc } from './deep-reference';
import { ReadRepository, RefAndMask } from '../utils/read-repository';
import type { Queryable, QuerySnapshot } from './collection';
import { Reference, UpdateOpts, SetOpts, Snapshot } from './reference';
import { MorphReference } from './morph-reference';
import { makeNormalSnap, NormalReference } from './normal-reference';
import { runUpdateLifecycle, guardEditMode } from '../utils/lifecycle';
import { VirtualReference } from './virtual-reference';
import type { GetOpts, Transaction } from './transaction';
import type { EditMode } from '../coerce/coerce-to-model';


export class ReadWriteTransaction implements Transaction {
  
  private readonly writes = new Map<string, WriteOp[]>();

  private readonly timestamp = new Date();
  private readonly atomicReads: ReadRepository;
  private readonly nonAtomicReads: ReadRepository;
  private readonly flatCollections = new Map<string, Promise<void>>();


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


    // Flatten writes to any deep references down to the native document
    const nativeWrites = new Map<string, WriteOp>();
    for (const ops of this.writes.values()) {
      for (const op of ops) {
        const { docRef, deepRef } = getRefInfo(op.ref);
        if (!docRef) {
          (op.ref as VirtualReference<any>).writeInternal(op.data || undefined, op.mode);
          break;
        }
      }

      const { docRef, deepRef } = getRefInfo(op.re);
      if (!docRef) {
        (ref as VirtualReference<T>).writeInternal(data, editMode);
        return;
      }

    }


    if (this.logStats) {
      strapi.log.debug(`TRANSACTION (attempt #${this.attempt}): ${nativeWrites.size} writes, ${this.atomicReads.readCount + this.nonAtomicReads.readCount} reads (${this.atomicReads.readCount} atomic).`);
    }

    // If we have fetched flat documents then we need to wait to
    // ensure that the document exists so that the update operate will succeed
    await Promise.all([...this.flatCollections.values()]);


    for (const ops of this.writes.values()) {
      for (const op of ops) {
        switch (op.mode) {
          case 'delete':
            this.nativeTransaction.delete(op.ref);
            break;
          case 'create':
            this.nativeTransaction.create(op.ref, op.data);
            break;
          case 'update':
            // Firestore does not run the converter on update operations
            op.data = op.converter.toFirestore(op.data);
            this.nativeTransaction.update(op.ref, op.data!);
            break;
          case 'set':
            this.nativeTransaction.set(op.ref, op.data);
            break;
          case 'setMerge':
            this.nativeTransaction.set(op.ref, op.data!, { merge: true });
            break;
          default:
            guardEditMode(op.mode);
        }
      }
    }
  }


  create<T extends object>(ref: Reference<T>, data: T, opts?: UpdateOpts): Promise<T>
  create<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  async create<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: UpdateOpts): Promise<T | Partial<T>> {
    return (await runUpdateLifecycle({
      editMode: 'create',
      ref,
      data,
      opts,
      transaction: this,
      timestamp: this.timestamp,
    }))!;
  }
  
  update<T extends object>(ref: Reference<T>, data: T, opts?: UpdateOpts): Promise<T>
  update<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  async update<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: UpdateOpts): Promise<T | Partial<T>> {
    return (await runUpdateLifecycle({
      editMode: 'update',
      ref,
      data,
      opts,
      transaction: this,
      timestamp: this.timestamp,
    }))!;
  }

  set<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  set<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async set<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    return (await runUpdateLifecycle({
      editMode: opts?.merge ? 'setMerge' : 'set',
      ref,
      data,
      opts,
      transaction: this,
      timestamp: this.timestamp,
    }))!;
  }
  
  async delete<T extends object>(ref: Reference<T>, opts?: UpdateOpts): Promise<void> {
    await runUpdateLifecycle({
      editMode: 'delete',
      ref,
      data: undefined,
      opts,
      transaction: this,
      timestamp: this.timestamp,
    });
  }


  
  /**
   * Merges a create, update, or delete operation into pending writes for a given
   * reference in this transaction, without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  mergeWriteInternal<T extends object>(ref: Reference<T>, data: Partial<T> | undefined, editMode: EditMode) {

    // If the write is for a flattened collection then pre-emptively start ensuring that the document exists
    if (ref instanceof DeepReference) {
      if (!this.flatCollections.get(ref.parent.path)) {
        this.flatCollections.set(ref.parent.path, ref.parent.ensureDocument());
      }
    }

    // Get existing or put new array of writes for this document
    let ops: WriteOp[] = this.writes.get(ref.path) || (() => {
      const ops: WriteOp[] = [];
      this.writes.set(ref.path, ops);
      return ops;
    })();

    // Create new op
    let op: WriteOp
    if (editMode === 'delete') {
     op = { ref, data: null, mode: 'delete' };
    } else {
      if (!data) {
        throw new Error(`Data for ${editMode} operation is undefined`);
      }
      op = { ref, data, mode: editMode };
    }

    const lastOp = ops[ops.length - 1] as WriteOp | undefined;

    // Merge data and ensure feasibility
    switch (op.mode) {
      case 'create':
        switch (lastOp?.mode) {
          case 'delete':
            // Create will replace the delete so issue a warning
            // then fall through to the next clause
            warnMergeOverridingData(op.mode, ref);

          case undefined:
            ops.splice(0, ops.length, op);
            break;

          case 'create':
          case 'update':
          case 'set':
          case 'setMerge':
            // Create operation requires that the document not exist
            throw new WriteCannotSucceedError(op.mode, lastOp.mode);

          default:
            guardEditMode(lastOp);
        }
        break;

      case 'setMerge':
      case 'update':
        switch (lastOp?.mode) {
          case undefined:
            // No previous ops, so we append
            ops.push(op);
            break;

          case 'delete':
            if (op.mode === 'update') {
              // Update operation requires that the document exists
              throw new WriteCannotSucceedError(op.mode, lastOp.mode);
            } else {
              warnMergeOverridingData(op.mode, ref);
              ops.splice(0, ops.length, op);
            }
            break;
            
          case 'create':
          case 'set':
          case 'setMerge':
            if ((op.mode === 'update') && Object.keys(op.data).some(key => key.includes('.'))) {
              // Update operation has nested paths (path with ".")
              // Such paths are only supported in update operations and the previous operation is not an update
              // So we cannot merge but instead need to append
              ops.push(op);
              break;
            } else {
              // We can merge, so fall through to the next clause 
            }

          case 'update':
            // Ok, we can merge the data, but keep existing mode
            // update mode does not override create, update, set, or setMerge (all assure that the document already exists)
            // setMerge mode does not override create, update, set, or setMerge
            let isKeysOverwritten = false;
            for (const key of Object.keys(data!)) {
              if (_.get(lastOp.data, key) !== undefined) {
                isKeysOverwritten = true;
              }
              _.set(lastOp.data, key, op.data[key]);
            }
            break;

          default:
            guardEditMode(lastOp);
        }
        break;

      case 'set':
      case 'delete':
        // Always feasible
        // Clear all existing operations and add the new one
        if (ops.length) {
          warnMergeOverridingData(op.mode, ref);
        }
        ops.splice(0, ops.length, op);
        break;


      default:
        guardEditMode(op);
    }


    // if (op.data === null) {
    //   // Deletion overrides all other operations
    //   return;
    // }

    // Don't create documents for flattened collections
    // because we use ensureDocument() and then update()
    // op.create = op.create || ((editMode === 'create') && !deepRef) || false;

    // if (deepRef) {
    //   Object.assign(op.data, mapToFlattenedDoc(deepRef, data, true));
    // } else {
    //   if (!data) {
    //     op.data = null;
    //   } else {
    //     Object.assign(op.data, data);
    //   }
    // }
  }
}


type WriteOp = {
  ref: Reference<any>
} & ({
  data: DocumentData
  mode: 'create' | 'update' | 'set' | 'setMerge'
} | {
  data: null
  mode: 'delete'
})

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

function warnMergeOverridingData(editMode: EditMode, ref: Reference<any>) {
  strapi.log.warn(`${editMode} is overwriting the data from one or more previous write operations for ${ref.path}`);
}

export class WriteCannotSucceedError extends Error {
  constructor(thisOperation: EditMode, previousOperation: EditMode) {
    super(`${thisOperation} can never succeed following a ${previousOperation}`);
  }
}
