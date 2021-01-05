import * as _ from 'lodash';
import { FieldValue, Transaction } from '@google-cloud/firestore';
import type { DeepReference } from './deep-reference';
import type { Snapshot } from './queryable-collection';
import type { ReadRepository } from './read-repository';

export function makeFlattenedSnap<T extends object>(ref: DeepReference<T>, snap: Snapshot<{[id: string]: T}>): Snapshot<T> {
  const data = snap.data()?.[ref.id];
  return {
    ref,
    data: () => data,
    id: ref.id,
    exists: data !== undefined,
  };
}

export async function getFlattenedDoc<T extends object>(ref: DeepReference<any>, transaction: Transaction | ReadRepository | null | undefined): Promise<Snapshot<T>> {
  const snap = await (transaction ? transaction.get(ref.doc) : ref.doc.get());
  return makeFlattenedSnap(ref, snap);
}


export function mapToFlattenedDoc<T extends object>({ id }: DeepReference<T>, data: Partial<T> | null, merge: boolean): { [id: string]: any } {
  if (typeof data !== 'object') {
    throw new Error(`Invalid data provided to Firestore. It must be an object but it was: ${JSON.stringify(data)}`);
  }
  
  if (!data) {
    return {
      [id]: FieldValue.delete(),
    };
  } else {
    if (merge) {
      // Flatten into key-value pairs to merge the fields
      return _.toPairs(data).reduce((d, [path, value]) => {
        d[`${id}.${path}`] = value;
        return d;
      }, {});
    } else {
      return { [id]: data };
    }
  }
}
