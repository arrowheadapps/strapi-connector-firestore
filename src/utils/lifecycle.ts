import * as _ from 'lodash';
import { CoerceOpts, coerceToModel } from '../coerce/coerce-to-model';
import { DeepReference } from '../db/deep-reference';
import { MorphReference } from '../db/morph-reference';
import { NormalReference } from '../db/normal-reference';
import type { Reference, SetOpts } from '../db/reference';
import type { Transaction, TransactionImpl } from '../db/transaction';
import { relationsUpdate, shouldUpdateRelations } from '../relations';

export interface LifecycleArgs<T extends object> extends Required<CoerceOpts> {
  ref: Reference<T>
  data: T | Partial<T> | undefined
  transaction?: TransactionImpl
  opts: SetOpts | undefined
}

/**
 * Runs the full lifecycle on the given reference including coercion and updating relations.
 * @returns The coerced data
 */
export async function runUpdateLifecycle<T extends object>({ ref, data, editMode, opts, transaction }: LifecycleArgs<T>): Promise<T | Partial<T> | undefined> {
  const db = ref.parent;
  const newData = data ? coerceToModel(db.model, ref.id, data, null, { editMode }) : undefined;

  if (shouldUpdateRelations(opts)) {

    const runUpdateWithRelations = async (trans: Transaction) => {
      const prevData = editMode === 'update'
        ? await trans.getAtomic(ref).then(snap => snap.data())
        : undefined;
      await relationsUpdate(db.model, ref, prevData, newData, trans);
      (trans as TransactionImpl).mergeWriteInternal(ref, newData, editMode);
    };
    
    if (transaction) {
      await runUpdateWithRelations(transaction);
    } else {
      await db.model.runTransaction(runUpdateWithRelations);
    }
  } else {
    if (transaction) {
      transaction.mergeWriteInternal(ref, newData, editMode);
    } else {
      if ((ref instanceof NormalReference)
        || (ref instanceof DeepReference)
        || (ref instanceof MorphReference)) {
        await ref.writeInternal(newData, editMode);
      } else {
        throw new Error(`Unknown type of reference: ${ref}`);
      }
    }
  }

  return newData;
}
