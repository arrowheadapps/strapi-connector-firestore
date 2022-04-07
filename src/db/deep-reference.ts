import * as _ from 'lodash';
import type { DocumentReference, DocumentSnapshot } from "@google-cloud/firestore";
import type { FlatCollection } from './flat-collection';
import { FlatReferenceShape, Reference, SetOpts, Snapshot } from './reference';
import { FieldOperation } from './field-operation';
import { runUpdateLifecycle } from '../utils/lifecycle';

/**
 * References an item in a flattened collection 
 * (i.e.) a field within a document.
 */
export class DeepReference<T extends object> extends Reference<T> {

  readonly doc: DocumentReference<{ [id: string]: T }>

  constructor(readonly id: string, readonly parent: FlatCollection<T>) {
    super();
    if (!id) {
      throw new Error('Document ID must not be empty');
    }

    this.doc = parent.document;
  }

  get path() {
    return `${this.doc.path}/${this.id}`;
  }


  get firestore() {
    return this.doc.firestore;
  }

  async delete(opts?: SetOpts) {
    await runUpdateLifecycle({
      editMode: 'update',
      ref: this,
      data: undefined,
      opts,
      timestamp: new Date(),
    });
  };

  create(data: T, opts?: SetOpts): Promise<T>
  create(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async create(data: T | Partial<T>, opts?: SetOpts) {
    return await runUpdateLifecycle({
      editMode: 'create',
      ref: this,
      data,
      opts,
      timestamp: new Date(),
    });
  };

  update(data: T, opts?: SetOpts): Promise<T>
  update(data: Partial<T>, opts?: SetOpts): Promise<Partial<T>>
  async update(data: T | Partial<T>, opts?: SetOpts) {
    return await runUpdateLifecycle({
      editMode: 'update',
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
  async writeInternal(data: Partial<T> | undefined, editMode: 'create' | 'update') {
    const d = mapToFlattenedDoc(this, data, editMode === 'update');
    await this.parent.ensureDocument();

    // TODO: Fail on create if document already exists
    // TODO: Fail on update if document doesn't exist

    // Firestore does not run the converter on update operations
    const out = this.parent.converter.toFirestore(d);
    await this.doc.update(out as any);
  }


  async get(): Promise<Snapshot<T>> {
    // Apply a field mask so only the specific entry in flattened document is returned
    // This saves bandwidth from the database
    const [snap] = await this.doc.firestore.getAll(this.doc, { fieldMask: [this.id] });
    return makeDeepSnap(this, snap);
  }

  isEqual(other: any) {
    return (this === other) || 
      (other instanceof DeepReference
        && this.id === other.id
        && this.doc.isEqual(other.doc));
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
  toFirestoreValue(): FlatReferenceShape<T> {
    return {
      ref: this.doc,
      id: this.id,
    };
  }

  toString() {
    return this.path;
  }
}


export function makeDeepSnap<T extends object>(ref: DeepReference<T>, snap: DocumentSnapshot<{[id: string]: T}>): Snapshot<T> {
  const data = snap.data()?.[ref.id];
  return {
    ref,
    data: () => data,
    id: ref.id,
    exists: data !== undefined,
  };
}

export function mapToFlattenedDoc<T extends object>({ id }: DeepReference<T>, data: Partial<T> | undefined, merge: boolean): { [id: string]: any } {
  if ((data !== undefined) && (typeof data !== 'object')) {
    throw new Error(`Invalid data provided to Firestore. It must be an object but it was: ${JSON.stringify(data)}`);
  }
  
  if (!data) {
    return {
      [id]: FieldOperation.delete(),
    };
  } else {
    if (merge) {
      // Flatten into key-value pairs to merge the fields
      return _.toPairs(data).reduce((d, [path, value]) => {
        d[`${id}.${path}`] = value;
        return d;
      }, {});
    } else {
      return { [id]: data };
    }
  }
}
