import type { Firestore } from '@google-cloud/firestore';
import type { ConnectorOptions, ModelOptions } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { ReadWriteTransaction } from '../db/readwrite-transaction';
import PQueue from 'p-queue';
import { ReadOnlyTransaction } from '../db/readonly-transaction';

export type TransactionRunner<T extends object> = FirestoreConnectorModel<T>['runTransaction'];

/**
 * Makes a function that runs a transaction.
 * If the connector is using an emulator then the return runner queues transactions
 * with a maximum concurrency limit.
 */
export function makeTransactionRunner<T extends object>(firestore: Firestore, options: Required<ModelOptions<T>>, connectorOptions: Required<ConnectorOptions>): TransactionRunner<T> {
  const { useEmulator, logTransactionStats } = connectorOptions;
  const isVirtual = options.virtualDataSource != null;

  const normalRunner: TransactionRunner<T> = async (fn, opts) => {
    const isReadOnly = isVirtual || (opts && opts.readOnly);
    if (isReadOnly) {
      // Always use read-only transactions for virtual collections
      // The only scenario where a virtual collection may want to perform a Firestore write is if it has
      // a dominant relation to a non-virtual collection. However, because of the (potentially) transient nature of
      // references to virtual collections, dominant relations to a virtual collection are not supported.
      // Don't log stats for virtual collections
      const trans = new ReadOnlyTransaction(firestore, logTransactionStats && !isVirtual);
      const result = await fn(trans);
      await trans.commit();
      return result;
    } else {
      let attempt = 0;
      return await firestore.runTransaction(async (trans) => {
        if ((attempt > 0) && useEmulator) {
          // Random back-off for contested transactions only when running on the emulator
          // The production server has deadlock avoidance but the emulator currently doesn't
          // See https://github.com/firebase/firebase-tools/issues/1629#issuecomment-525464351
          // See https://github.com/firebase/firebase-tools/issues/2452
          const ms = Math.random() * 5000;
          strapi.log.warn(`There is contention on a document and the Firestore emulator is getting deadlocked. Waiting ${ms.toFixed(0)}ms.`);
          await new Promise(resolve => setTimeout(resolve, ms));
        }

        const wrapper = new ReadWriteTransaction(firestore, trans, logTransactionStats, ++attempt);
        const result = await fn(wrapper);
        await wrapper.commit();
        return result;
      });
    }
  };

  // Virtual option overrides flatten option
  if (options.flatten && !isVirtual) {
    const queue = new PQueue({ concurrency: 1 });
    return async (fn, opts) => {
      if (opts && opts.readOnly) {
        // Read-only transactions can succeed concurrently because they don't lock any documents
        // and will not contend with any other transactions
        return normalRunner(fn, opts);
      } else {
        // When using flattened collections, only one read-write transaction can be executed at a time
        // So we queue them up rather than allowing them to contend 
        // Contention which would introduce 30-second timeout delays on the emulator, and cause unnecessary
        // read and write operations on the production server
        return await queue.add(() => normalRunner(fn));
      }
    };
  } else {
    return normalRunner;
  }
}
