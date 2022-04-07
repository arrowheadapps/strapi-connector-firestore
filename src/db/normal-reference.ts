import * as _ from 'lodash';
import type { DocumentReference, DocumentSnapshot } from '@google-cloud/firestore';
import { Reference, SetOpts, Snapshot } from './reference';
import type { NormalCollection } from './normal-collection';
import { runUpdateLifecycle } from '../utils/lifecycle';

/**
 * Acts as a wrapper around a native `DocumentReference`,
 */
export class NormalReference<T extends object> extends Reference<T> {

  constructor(readonly ref: DocumentReference<T>, readonly parent: NormalCollection<T>) {
    super();
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

  async delete(opts?: SetOpts) {
    await runUpdateLifecycle({
      editMode: 'update',
      ref: this,
      data: undefined,
      opts,
      timestamp: new Date(),
      ignoreMismatchedReferences: this.parent.model.options.ignoreMismatchedReferences,
    });
  }

  async create(data: T, opts?: SetOpts): Promise<T>
  async create(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async create(data: T | Partial<T>, opts?: SetOpts) {
    return await runUpdateLifecycle({
      editMode: 'create',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
      ignoreMismatchedReferences: this.parent.model.options.ignoreMismatchedReferences,
    });
  }

  update(data: T, opts?: SetOpts): Promise<T>
  update(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async update(data: T | Partial<T>, opts?: SetOpts) {
    return await runUpdateLifecycle({
      editMode: 'update',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
      ignoreMismatchedReferences: this.parent.model.options.ignoreMismatchedReferences,
    });
  }
  

  /**
   * Performs a `create()`, `update()`, or `delete()` operation without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  async writeInternal(data: Partial<T> | undefined, editMode: 'create' | 'update') {
    if (data) {
      if (editMode === 'create') {
        await this.ref.create(data as T);
      } else {
        // Firestore does not run the converter on update operations
        const out = this.parent.converter.toFirestore(data as T);
        await this.ref.update(out as any);
      }
    } else {
      await this.ref.delete();
    }
  }

  async get() {
    return makeNormalSnap(this, await this.ref.get());
  }

  isEqual(other: any) {
    return (this === other) || ((other instanceof NormalReference)
      && this.ref.isEqual(other.ref));
  }

  /**
   * Allow serialising to JSON.
   */
  toJSON() {
    return this.id;
  }

  /**
   * Returns a value that can be serialised
   * to Firestore.
   */
  toFirestoreValue(): DocumentReference<T> {
    return this.ref;
  }

  toString() {
    return this.path;
  }
}

export function makeNormalSnap<T extends object>(ref: NormalReference<T>, snap: DocumentSnapshot<T>): Snapshot<T> {
  const data = snap.data();
  return {
    ref,
    data: () => data,
    id: snap.id,
    exists: snap.exists,
  };
}
