import type { Firestore } from '@google-cloud/firestore';
import type { ConnectorOptions, ModelOptions } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { TransactionImpl } from '../db/transaction';
import PQueue from 'p-queue';

export type TransactionRunner<T extends object> = FirestoreConnectorModel<T>['runTransaction'];

/**
 * Makes a function that runs a transaction.
 * If the connector is using an emulator then the return runner queues transactions
 * with a maximum concurrency limit.
 */
export function makeTransactionRunner<T extends object>(firestore: Firestore, options: Required<ModelOptions<T>>, connectorOptions: Required<ConnectorOptions>): TransactionRunner<T> {
  const { useEmulator, logTransactionStats } = connectorOptions;

  const normalRunner: TransactionRunner<T> = async (fn) => {
    let attempt = 0;
    return await firestore.runTransaction(async (trans) => {
      if ((attempt > 0) && useEmulator) {
        // Random backoff for contested transactions only when running on the emulator
        // The production server has deadlock avoidance but the emulator currently doesn't
        // See https://github.com/firebase/firebase-tools/issues/1629#issuecomment-525464351
        // See https://github.com/firebase/firebase-tools/issues/2452
        const ms = Math.random() * 5000;
        strapi.log.warn(`There is contention on a document and the Firestore emulator is getting deadlocked. Waiting ${ms.toFixed(0)}ms.`);
        await new Promise(resolve => setTimeout(resolve, ms));
      }

      const wrapper = new TransactionImpl(firestore, trans, logTransactionStats, ++attempt);
      const result = await fn(wrapper);
      await wrapper.commit();
      return result;
    });
  };

  if (options.flatten) {
    // When using flattened collections, only one transaction can be executed at a time
    // So we queue them up rather than allowing them to contend which would
    // introduce 30-second timeout delays (on the emulator)
    
    // TODO: Read-only transactions can succeed concurrently
    // but we can't distinguish this at the moment
    const queue = new PQueue({ concurrency: 1 });
    return async (fn) => {
      return await queue.add(() => normalRunner(fn));
    };
  } else {
    return normalRunner;
  }
}
