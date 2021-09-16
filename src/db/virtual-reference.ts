import * as _ from 'lodash';
import { Reference, UpdateOpts, SetOpts, Snapshot } from './reference';
import { runUpdateLifecycle, guardEditMode } from '../utils/lifecycle';
import { VirtualCollection } from './virtual-collection';
import { DocumentReference } from '@google-cloud/firestore';
import { StatusError } from '../utils/status-error';
import { FieldOperation } from './field-operation';
import type { EditMode } from '../coerce/coerce-to-model';

/**
 * References an item in a virtual collection.
 */
export class VirtualReference<T extends object> extends Reference<T> {


  constructor(readonly id: string, readonly parent: VirtualCollection<T>) {
    super();
    if (!id) {
      throw new Error('Document ID must not be empty');
    }
  }

  get path() {
    return `${this.parent.path}/${this.id}`;
  }


  get firestore() {
    return this.parent.model.firestore;
  }

  async delete(opts?: UpdateOpts) {
    await runUpdateLifecycle({
      editMode: 'delete',
      ref: this,
      data: undefined,
      opts,
      timestamp: new Date(),
    });
  };

  create(data: T, opts?: UpdateOpts): Promise<T>
  create(data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  async create(data: T | Partial<T>, opts?: UpdateOpts) {
    return await runUpdateLifecycle({
      editMode: 'create',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
    });
  };

  update(data: T, opts?: UpdateOpts): Promise<T>
  update(data: Partial<T>, opts?: UpdateOpts): Promise<Partial<T>>
  async update(data: T | Partial<T>, opts?: UpdateOpts) {
    return await runUpdateLifecycle({
      editMode: 'update',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
    });
  }

  set(data: T, opts?: SetOpts): Promise<T>
  set(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async set(data: T | Partial<T>, opts?: SetOpts) {
    return await runUpdateLifecycle({
      editMode: opts?.merge ? 'setMerge' : 'set',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
    });
  }

  /**
   * Performs a `create()`, `update()`, or `delete()` operation without any coercion or lifecycles.
   * @private
   * @deprecated For internal connector use only
   */
  async writeInternal(data: Partial<T> | undefined, editMode: EditMode) {
    const virtualData = await this.parent.getData();

    if (data === undefined) {
      delete virtualData[this.id];
    } else {
      const existingData = virtualData[this.id];

      switch (editMode) {
        case 'create':
          if (existingData !== undefined) {
            throw new StatusError(`Cannot create a new document that already exists (document: ${this.path})`, 400);
          }
          break;
        case 'update':
          if (existingData === undefined) {
            throw new StatusError(`Cannot update a document that does not exist (document: ${this.path})`, 400);
          }
          break;

        case 'delete':
        case 'set':
        case 'setMerge':
          // Ok
          break;
        default:
          guardEditMode(editMode);
      }

      // Don't coerce back to native Firestore values because we don't need to
      // The data has already been coerced to the model schema

      const newData = virtualData[this.id] = (existingData || {})

      for (const key of Object.keys(data)) {
        // TODO: Manually handle FieldOperation instances deeper in the data
        FieldOperation.apply(newData, key, data[key]);
      }

      await this.parent.updateData();
    }
  }


  async get(): Promise<Snapshot<T>> {
    const virtualData = await this.parent.getData();
    const data = virtualData[this.id];
    const converted = data ? this.parent.converter.fromFirestore(data) : undefined;
    return makeVirtualSnap(this, converted);
  }

  isEqual(other: any) {
    return (this === other) ||
      (other instanceof VirtualReference
        && this.id === other.id);
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
    // If other collections reference this virtual collection, then it looks like a normal reference.
    return this.parent.model.firestore.collection(this.parent.path).doc(this.id) as DocumentReference<T>;
  }

  toString() {
    return this.path;
  }
}


export function makeVirtualSnap<T extends object>(ref: VirtualReference<T>, data: T | undefined): Snapshot<T> {
  return {
    ref,
    data: () => data,
    id: ref.id,
    exists: data !== undefined,
  };
}
