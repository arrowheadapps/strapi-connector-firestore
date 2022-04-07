import type { Transaction as FirestoreTransaction } from '@google-cloud/firestore';
import type { Queryable, QuerySnapshot } from './collection';
import type { Reference, SetOpts, Snapshot } from './reference';

export interface TransactionOpts {
  /**
   * Makes this a read-only transaction. Read-only transactions do not run any native Firestore transaction,
   * and cannot perform any writes, they are only useful for caching read data.
   * Furthermore, atomic-read operations are not supported.
   * @default false
   */
  readOnly?: boolean;

  /**
   * The maximum number of attempts for this transaction.
   * Does not apply to read-only transactions, which only have a single attempt.
   */
  maxAttempts?: number;
}

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
   * Enqueues a callback which will be executed after the transaction block is run
   * and before the transaction is committed.
   * 
   * Firestore does not allow any reads from the transaction subsequent to any write.
   * This Transaction wrapper allows any order of reads or writes by batching and merging the
   * writes at the end of the transaction. If you add a write directly to the transaction,
   * you could cause reads and queries from relation updates to fail.
   * 
   * Therefore, if you wish to add a write to the transaction, add the write inside this callback.
   * 
   * For example:
   * 
   * ```
   * transaction.addNativeWrite(trans => trans.update(…));
   * ```
   */
  addNativeWrite(cb: (transaction: FirestoreTransaction) => void): void;

  /**
   * Adds a callback that will be run after the transaction is successfully committed.
   * The callback must not throw.
   */
  addSuccessHook(cb: () => (void | PromiseLike<void>)): void;
  
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
