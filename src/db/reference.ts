import * as _ from 'lodash';
import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import type { Collection } from './collection';


/**
 * Deep equality algorithm based on `_.isEqual()` with special handling
 * of objects that have their own `isEqual()` method, such as `Reference`.
 */
export function isEqualHandlingRef(a: any, b: any): boolean {
  return _.isEqualWith(a, b, (aValue, bValue) => {
    if (aValue && (typeof aValue === 'object')) {
      const { isEqual } = aValue;
      if (typeof isEqual === 'function') {
        return (isEqual as Function).bind(aValue)(bValue);
      }
    }
    return undefined;
  });
}

/**
 * The shape of references as stored in Firestore.
 */
export type ReferenceShape<T extends object> = 
  DocumentReference<T> |
  FlatReferenceShape<T> |
  MorphReferenceShape<T>;

export interface FlatReferenceShape<T extends object> {
  ref: DocumentReference<{ [id: string]: T }>
  id: string
}

export type MorphReferenceShape<T extends object> = NormalMorphReferenceShape<T> | FlatMorphReferenceShape<T>;

export interface NormalMorphReferenceShape<T extends object> {
  ref: DocumentReference<T>
  filter: string | null
}

export interface FlatMorphReferenceShape<T extends object> extends FlatReferenceShape<T> {
  filter: string | null
}




export interface Snapshot<T extends object> {
  data(): T | undefined
  ref: Reference<T>
  id: string
  exists: boolean
}


export interface SetOpts {
  /**
   * Indicates whether relation links should be updated on
   * other related documents. This can extra reads, queries
   * and writes to multiple documents.
   * 
   * If not updated, reference links will get into invalid states,
   * so it should be done unless you know what you're doing.
   * 
   * Defaults to `true`.
   */
  updateRelations?: boolean
}

/**
 * Common interface for normal, flattened, and polymorphic references.
 * References perform coercion on input data according to the model
 * schema that they belong to.
 */
export abstract class Reference<T extends object> {

  abstract readonly parent: Collection<T>;
  abstract readonly id: string;
  abstract readonly path: string;

  abstract readonly firestore: Firestore;

  abstract delete(opts?: SetOpts): Promise<void>;

  /**
   * @returns The coerced data
   */
  abstract create(data: T, opts?: SetOpts): Promise<T>;
  abstract create(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>;

  /**
   * @returns The coerced data
   */
  abstract update(data: T, opts?: SetOpts): Promise<T>;
  abstract update(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>;

  abstract get(): Promise<Snapshot<T>>;

  abstract isEqual(other: any): boolean;

  /**
   * Allow serialising to JSON.
   */
  abstract toJSON(): any;

  /**
   * Returns a value that can be serialised to Firestore.
   */
  abstract toFirestoreValue(): ReferenceShape<T>;

  toString(): string {
    return this.path;
  }
}
