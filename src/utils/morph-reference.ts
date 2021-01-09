import * as _ from 'lodash';
import { DeepReference } from './deep-reference';
import type { CollectionReference, DocumentReference, SetOptions } from '@google-cloud/firestore';
import { MorphReferenceShape, QueryableCollection } from './queryable-collection';


/**
 * Acts as a wrapper around a `DocumentReference` or a `DeepReference`
 * with additional field/filter information for polymorphic references.
 */
export class MorphReference<T extends object> {

  constructor(readonly ref: DocumentReference<T> | DeepReference<T>, readonly filter: string | null) {

  }

  get parent(): QueryableCollection<T> | CollectionReference<T> {
    return this.ref.parent;
  }

  get id(): string {
    return this.ref.id;
  }

  get path() {
    return this.ref.path;
  }

  get firestore() {
    return this.ref.firestore;
  }

  delete() {
    return this.ref.delete();
  };

  create(data: T) {
    return this.ref.create(data);
  };

  async update(data: Partial<T>) {
    return this.ref.update(data);
  };

  set(data: T): Promise<void>
  set(data: Partial<T>, options: SetOptions): Promise<void>
  set(data: T | Partial<T>, options?: SetOptions) {
    if (options) {
      return this.ref.set(data, options);
    } else {
      return this.ref.set(data as T);
    }
  }

  get() {
    return this.ref.get();
  }

  isEqual(other: MorphReference<T>) {
    return (this === other) || 
      (other instanceof MorphReference
        && this.ref.isEqual(other.ref as any)
        && (this.filter === other.filter));
  }

  /**
   * Allow serialising to JSON.
   */
  toJSON() {
    // This Strapi behaviour isn't really documented
    const model = strapi.db.getModelByCollectionName(this.ref.parent.path)!;
    return {
      ref: model.modelName,
      kind: model.globalId,
      source: model.plugin,
      refId: this.id,
      field: this.filter || undefined,
    };
  }

  /**
   * Returns a value that can be serialised
   * to Firestore.
   */
  toFirestoreValue(): MorphReferenceShape<T> {
    const value: MorphReferenceShape<T> = this.ref instanceof DeepReference
      ? { ...this.ref.toFirestoreValue(), filter: this.filter } 
      : { ref: this.ref, filter: this.filter };

    return value;
  }

  toString() {
    return this.toFirestoreValue();
  }

  
}