import * as _ from 'lodash';
import { DeepReference } from './deep-reference';
import type { QueryableCollection } from './queryable-collection';
import { MorphReferenceShape, Reference, SetOpts } from './reference';
import type { NormalReference } from './normal-reference';
import type { ModelData } from 'strapi';


/**
 * Acts as a wrapper around a `NormalReference` or a `DeepReference`
 * with additional field/filter information for polymorphic references.
 */
export class MorphReference<T extends ModelData> extends Reference<T> {

  constructor(readonly ref: NormalReference<T> | DeepReference<T>, readonly filter: string | null) {
    super();
  }

  get parent(): QueryableCollection<T> {
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

  delete(opts?: SetOpts) {
    return this.ref.delete();
  };

  create(data: T, opts?: SetOpts): Promise<T>
  create(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  create(data: T | Partial<T>, opts?: SetOpts): Promise<T | Partial<T>> {
    return this.ref.create(data, opts);
  };

  update(data: T, opts?: SetOpts): Promise<T>
  update(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  update(data: Partial<T>, opts?: SetOpts) {
    return this.ref.update(data, opts);
  }

  /**
   * Performs a `create()`, `update()`, or `delete()` operation without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  writeInternal(data: Partial<T> | undefined, editMode: 'create' | 'update') {
    return this.ref.writeInternal(data, editMode);
  }

  get() {
    return this.ref.get();
  }

  isEqual(other: any) {
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
    const { model } = this.ref.parent;
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
      : { ref: this.ref.ref, filter: this.filter };

    return value;
  }

  toString() {
    return this.id;
  }

  
}