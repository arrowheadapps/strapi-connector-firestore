import * as _ from 'lodash';
import { FieldValue } from '@google-cloud/firestore';
import { isEqualHandlingRef } from './queryable-collection';

/**
 * Acts as a wrapper for Firestores `FieldValue` but allows
 * manual implementation (where Firestore's) API is not public.
 */
export abstract class FieldOperation {

  static delete(): FieldOperation {
    return new DeleteFieldOperation();
  }

  static arrayRemove(...items: any[]): FieldOperation {
    return new ArrayRemoveFieldOperation(items);
  }

  static arrayUnion(...items: any[]): FieldOperation {
    return new ArrayUnionFieldOperation(items);
  }

  /**
   * Sets the given value and the given path or applies the 
   * transform if the value is a transform.
   */
  static apply(data: any, fieldPath: string, valueOrOperation: any): void {
    const value = _.get(data, fieldPath);
    const result = valueOrOperation instanceof FieldOperation
      ? valueOrOperation.transform(value)
      : value;
    if (result === undefined) {
      _.unset(data, fieldPath);
    } else {
      _.set(data, fieldPath, result);
    }
  }

  /**
   * Converts the operation to its Firestore-native
   * `FieldValue` equivalent.
   */
  abstract toFirestoreValue(): FieldValue;

  /**
   * Performs the operation on the given data.
   */
  abstract transform(value: any): any;


  /**
   * Returns another instance of this operation which
   * has any values coerced using the given function.
   * @param coerceFn The function that coerces each value
   */
  abstract coerceWith(coerceFn: (value: any) => any): FieldOperation;


  /**
   * @deprecated Unsupported operation
   */
  toJSON(): never {
    throw new Error('Instance of FieldOperation class cannot be serialised to JSON')
  }
}


class DeleteFieldOperation extends FieldOperation {

  constructor() {
    super()
  }

  toFirestoreValue(): FieldValue {
    return FieldValue.delete();
  }

  transform(): undefined {
    return undefined;
  }

  coerceWith() {
    return this;
  }
}

class ArrayUnionFieldOperation extends FieldOperation {

  constructor(readonly elements: any[]) {
    super()
  }

  toFirestoreValue(): FieldValue {
    return FieldValue.arrayUnion(...this.elements);
  }

  transform(value: any): any[] {
    // Add any instances that aren't already existing 
    // If the value was not an array then it is overwritten with
    // an empty array
    const arr = (Array.isArray(value) ? value : []);
    const toAdd = this.elements
      .filter(e => !arr.some(value => isEqualHandlingRef(value, e)));
    return arr.concat(toAdd);
  }

  coerceWith(coerceFn: (value: any) => any) {
    return new ArrayUnionFieldOperation(this.elements.map(coerceFn));
  }
}


class ArrayRemoveFieldOperation extends FieldOperation {

  constructor(readonly elements: any[]) {
    super()
  }

  toFirestoreValue(): FieldValue {
    return FieldValue.arrayRemove(...this.elements);
  }

  transform(value: any): any[] {
    // Remove all instances from the array 
    // If the value was not an array then it is overwritten with
    // an empty array
    return (Array.isArray(value) ? value : [])
      .filter(value => !this.elements.some(e => isEqualHandlingRef(value, e)));
  }

  coerceWith(coerceFn: (value: any) => any) {
    return new ArrayRemoveFieldOperation(this.elements.map(coerceFn));
  }
}
