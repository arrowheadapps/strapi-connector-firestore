import * as _ from 'lodash';
import { DeepReference } from './deep-reference';
import type { Collection } from './collection';
import { MorphReferenceShape, Reference, UpdateOpts, SetOpts } from './reference';
import { NormalReference } from './normal-reference';
import { VirtualReference } from './virtual-reference';
import type { EditMode } from '../coerce/coerce-to-model';


/**
 * Acts as a wrapper around a `NormalReference` or a `DeepReference`
 * with additional field/filter information for polymorphic references.
 */
export class MorphReference<T extends object> extends Reference<T> {

  constructor(readonly ref: NormalReference<T> | DeepReference<T> | VirtualReference<T>, readonly filter: string | null) {
    super();
  }

  get parent(): Collection<T> {
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

  delete(opts?: UpdateOpts) {
    return this.ref.delete(opts);
  };

  create(data: T, opts?: UpdateOpts): Promise<T>
  create(data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  create(data: T | Partial<T>, opts?: UpdateOpts): Promise<T | Partial<T>> {
    return this.ref.create(data, opts);
  }

  update(data: T, opts?: UpdateOpts): Promise<T>
  update(data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  update(data: Partial<T>, opts?: UpdateOpts) {
    return this.ref.update(data, opts);
  }

  set(data: T, opts?: SetOpts): Promise<T>
  set(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  set(data: Partial<T>, opts?: SetOpts) {
    return this.ref.set(data, opts);
  }

  /**
   * Performs a `create()`, `update()`, or `delete()` operation without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  writeInternal(data: Partial<T> | undefined, editMode: EditMode) {
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
      : { ref: this.ref.toFirestoreValue(), filter: this.filter };

    return value;
  }

  toString() {
    return this.id;
  }

  
}