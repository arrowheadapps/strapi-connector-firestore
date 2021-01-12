import * as _ from 'lodash';
import { FieldValue } from '@google-cloud/firestore';
import { isEqualHandlingRef } from './queryable-collection';

/**
 * Acts as a wrapper for Firestores `FieldValue` but allows
 * manual implementation (where Firestore's) API is not public.
 */
export abstract class FieldOperation {

  static arrayRemove(...items: any[]): FieldOperation {
    return new ArrayRemoveFieldOperation(items);
  }

  static arrayUnion(...items: any[]): FieldOperation {
    return new ArrayUnionFieldOperation(items);
  }


  abstract toFirestoreValue(): FieldValue;
  abstract operate(data: any, fieldPath: string): void;

  /**
   * @deprecated Unsupported operation
   */
  toJSON(): never {
    throw new Error('Instance of FieldOperation class cannot be serialised to JSON')
  }
}

class ArrayUnionFieldOperation extends FieldOperation {

  constructor(readonly elements: any[]) {
    super()
  }

  toFirestoreValue(): FieldValue {
    return FieldValue.arrayUnion(...this.elements);
  }

  operate(data: any, fieldPath: string) {
    // Add any instances that aren't already existing 
    // If the value was not an array then it is overwritten with
    // an empty array
    const fieldValue = _.get(data, fieldPath);
    const result = (Array.isArray(fieldValue) ? fieldValue : []);
    this.elements.forEach(e => {
      if (!result.some(value => isEqualHandlingRef(value, e))) {
        result.push(e);
      }
    });

    _.set(data, fieldPath, result);
  }

}


class ArrayRemoveFieldOperation extends FieldOperation {

  constructor(readonly elements: any[]) {
    super()
  }

  toFirestoreValue(): FieldValue {
    return FieldValue.arrayRemove(...this.elements);
  }

  operate(data: any, fieldPath: string) {
    // Remove all instances from the array 
    // If the value was not an array then it is overwritten with
    // an empty array
    const fieldValue = _.get(data, fieldPath);
    const result = (Array.isArray(fieldValue) ? fieldValue : [])
      .filter(value => !this.elements.some(e => isEqualHandlingRef(value, e)));

    _.set(data, fieldPath, result);
  }

}
