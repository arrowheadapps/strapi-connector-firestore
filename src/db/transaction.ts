import type { Transaction as FirestoreTransaction } from '@google-cloud/firestore';
import type { Queryable, QuerySnapshot } from './collection';
import type { Reference, UpdateOpts, SetOpts, Snapshot } from './reference';

export interface TransactionOpts {
  /**
   * Makes this a read-only transaction. Read-only transactions do not run any native Firestore transaction,
   * and cannot perform any writes, they are only useful for caching read data.
   * Furthermore, atomic-read operations are not supported.
   * @default false
   */
  readOnly?: boolean;
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
 *  - The `getNonAtomic(…)` methods will reuse a cached read
 *    from a `getAtomic(…)` call, but not the other way around. 
 *  - The `getAtomic(…)` functions perform the read operations within
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
   * fetched and locked using `getAtomic(…)` within this transaction.
   * Does not return a cached response from `getNonAtomic(…)` because
   * that would not establish a lock.
   */
  getAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>

  /**
   * Reads the given document. Returns a cached response if the document
   * has been read *(with `getNonAtomic(…)` or `getAtomic(…)`)* within
   * this transaction.
   */
  getNonAtomic<T extends object>(ref: Reference<T>, opts?: GetOpts): Promise<Snapshot<T>>
  getNonAtomic<T extends object>(refs: Reference<T>[], opts?: GetOpts): Promise<Snapshot<T>[]>
  getNonAtomic<T extends object>(query: Queryable<T>): Promise<QuerySnapshot<T>>

  /**
   * Creates the given document, failing if it already exists.
   * 
   * The data is merged with any other `create(…)`, `update(…)`, `set(…)`, or `set(…, { merge: true })` 
   * operations performed on this transaction.
   * 
   * The "create" operation takes precedence over "update" operations, but is overridden by "set" and "delete".
   * 
   * @returns The coerced data
   */
  create<T extends object>(ref: Reference<T>, data: T, opts?: UpdateOpts): Promise<T>
  create<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  
  /**
   * Updates the given document, failing if it does not exist.
   * 
   * The data is merged with any other `create(…)`, `update(…)`, `set(…)`, or `set(…, { merge: true })`
   * operations performed on this transaction, and overrides the overall operation to be "update".
   * 
   * The "update" but is overridden by "create", "set" and "delete".
   * 
   * @returns The coerced data
   */
  update<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: UpdateOpts): Promise<T>
  update<T extends object>(ref: Reference<T>, data: Partial<Partial<T>>, opts?: UpdateOpts): Promise<Partial<T>>

  /**
   * Creates or overwrites the document.
   * 
   * The data is merged with any other `create(…)`, `update(…)`, `set(…)`, or `set(…, { merge: true })` 
   * operations performed on this transaction, and overrides the overall operation to be "create".
   * 
   * The "set" operation is overridden by "delete".
   * 
   * @returns The coerced data
   */
   set<T extends object>(ref: Reference<T>, data: Partial<T>, opts?: SetOpts): Promise<T>
   set<T extends object>(ref: Reference<T>, data: Partial<Partial<T>>, opts?: SetOpts): Promise<Partial<T>>

  /**
   * Deletes the given document, overriding all other write operations
   * on the document in this transaction.
   */
  delete<T extends object>(ref: Reference<T>, opts?: UpdateOpts): Promise<void>
}
