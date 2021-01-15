import * as _ from 'lodash';
import type { DocumentData } from '@google-cloud/firestore';
import { DeepReference } from '../utils/deep-reference';
import { MorphReference } from '../utils/morph-reference';
import { FieldOperation } from '../utils/field-operation';

/**
 * Lightweight converter that converts known custom classes
 * to Firestore-compatible values.
 */
export function coerceToFirestore<T extends object>(data: T, isRootObj = true): DocumentData {
  const obj = _.cloneDeepWith(data, value => {
    if ((value instanceof DeepReference) || (value instanceof MorphReference)) {
      return value.toFirestoreValue();
    }

    // Coerce values within FieldOperation
    // and convert to its native counterpart
    if (value instanceof FieldOperation) {
      return value
        .coerceWith(coerceToFirestore)
        .toFirestoreValue();
    }

    return undefined;
  });

  if (isRootObj) {
    delete obj[model.primaryKey];
  }

  return obj;
}
