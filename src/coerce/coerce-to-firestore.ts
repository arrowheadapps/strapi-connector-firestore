import * as _ from 'lodash';
import { Model, ModelData } from 'strapi';
import { FieldOperation } from '../db/field-operation';

/**
 * Lightweight converter for a root model object. Ensures that the
 * `primaryKey` is not set on the Firestore data.
 */
export function coerceModelToFirestore<T extends ModelData>(model: Model<T>, data: T): T {
  const obj = coerceToFirestore(data);
  _.unset(obj, model.primaryKey);
  return obj;
}

/**
 * Lightweight converter that converts known custom classes
 * to Firestore-compatible values.
 */
export function coerceToFirestore<T extends ModelData>(data: T): T {
  return _.cloneDeepWith(data, value => {
    
    // Coerce values within FieldOperation
    // and convert to its native counterpart
    if (value instanceof FieldOperation) {
      return value
        .coerceWith(coerceToFirestore)
        .toFirestoreValue();
    }

    if (value && (typeof value === 'object') && ('toFirestoreValue' in value)) {
      return value.toFirestoreValue()
    }

    return undefined;
  });
}
