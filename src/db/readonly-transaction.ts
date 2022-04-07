import type { Transaction as FirestoreTransaction, Firestore } from '@google-cloud/firestore';
import { ReadRepository } from '../utils/read-repository';
import type { Queryable, QuerySnapshot } from './collection';
import type { Reference, SetOpts, Snapshot } from './reference';
import { VirtualReference } from './virtual-reference';
import type { GetOpts, Transaction } from './transaction';
import { get, getAll, getRefInfo } from './readwrite-transaction';


export class ReadOnlyTransaction implements Transaction {
  
  private readonly nonAtomicReads: ReadRepository;


  /**
   * @private
   * @deprecated For internal connector use only
   */
  readonly successHooks: (() => (void | PromiseLike<void>))[] = [];


  /**
   * @deprecated Not supported on ReadonlyTransaction
   */
  get nativeTransaction(): FirestoreTransaction {
    throw new Error('nativeTransaction is not supported on ReadonlyTransaction');
  }


  constructor(
    readonly firestore: Firestore,
    private readonly logStats: boolean,
  ) {
    this.nonAtomicReads = new ReadRepository({
      getAll: (refs, fieldMask) => firestore.getAll(...refs, { fieldMask }),
      getQuery: query => query.get(),
    });
  }

  /**
   * @deprecated Not supported on ReadOnlyTransaction
   */
  getAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>
  getAtomic<T extends object>(): Promise<Snapshot<T> | Snapshot<T>[] | QuerySnapshot<T>> {
    throw new Error('getAtomic() is not supported on ReadOnlyTransaction');
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
  commit() {
    if (this.logStats && this.nonAtomicReads.readCount) {
      strapi.log.debug(`TRANSACTION (read-only): ${this.nonAtomicReads.readCount} reads.`);
    }
    return Promise.resolve();
  }


  create<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  create<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async create<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    if (ref instanceof VirtualReference) {
      return await ref.create(data, opts);
    } else {
      throw new Error('create() is not supported on ReadOnlyTransaction');
    }
  }
  
  update<T extends object>(ref: Reference<T>, data: T, opts?: SetOpts): Promise<T>
  update<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async update<T extends object>(ref: Reference<T>, data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    if (ref instanceof VirtualReference) {
      return await ref.update(data, opts);
    } else {
      throw new Error('update() is not supported on ReadOnlyTransaction');
    }
  }
  
  async delete<T extends object>(ref: Reference<T>): Promise<void> {
    if (ref instanceof VirtualReference) {
      return await ref.delete();
    } else {
      throw new Error('delete() is not supported on ReadOnlyTransaction');
    }
  }

  /**
   * @deprecated Not supported on ReadOnlyTransaction
   */
  addNativeWrite(): never {
    throw new Error('Writes are not supported on ReadOnlyTransaction');
  }

  addSuccessHook(cb: () => (void | PromiseLike<void>)): void {
    this.successHooks.push(cb);
  }
  
  /**
   * Performs write operations only for virtual references. All other write operations
   * are not supported.
   * @private
   * @deprecated For internal connector use only
   */
  mergeWriteInternal<T extends object>(ref: Reference<T>, data: Partial<T> | undefined, editMode: 'create' | 'update') {
    const { docRef } = getRefInfo(ref);
    if (!docRef) {
      (ref as VirtualReference<T>).writeInternal(data, editMode);
      return;
    }
  }
}
