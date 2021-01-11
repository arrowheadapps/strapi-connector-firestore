import * as _ from 'lodash';
import * as path from 'path';
import type { DocumentData, DocumentReference, SetOptions } from "@google-cloud/firestore";
import type { FlatReferenceShape, Snapshot } from "./queryable-collection";
import type { QueryableFlatCollection } from './queryable-flat-collection';
import { getFlattenedDoc, mapToFlattenedDoc } from './flattened-doc';

/**
 * References an item in a flattened collection 
 * (i.e.) a field within a document.
 */
export class DeepReference<T extends object = DocumentData> {

  readonly doc: DocumentReference<{ [id: string]: T }>

  constructor(readonly id: string, readonly parent: QueryableFlatCollection<T>) {
    if (!id) {
      throw new Error('Document ID must not be empty');
    }

    this.doc = parent.flatDoc;
  }

  get path() {
    return path.posix.join(this.doc.path, this.id);
  }


  get firestore() {
    return this.doc.firestore;
  }

  async delete() {
    await this._set(null, false);
  };

  async create(data: T) {
    // TODO:
    // Error if document already exists
    await this._set(data, false);
  };

  async update(data: Partial<T>) {
    // TODO:
    // Error if document doesn't exist
    await this._set(data, false);
  };

  set(data: T): Promise<void>
  set(data: T | Partial<T>, options: SetOptions): Promise<void>
  async set(data: Partial<T>, options?: SetOptions) {
    await this._set(data, options?.merge || false);
  }

  async get(): Promise<Snapshot<T>> {
    return await getFlattenedDoc(this, null);
  }

  private async _set(data: Partial<T> | null, merge: boolean) {

    // HACK:
    // It seems that Firestore does not call the converter
    // for update operations?
    // FIXME: For plain DocumentReference instances the converter will not be called
    const out = this.parent.conv.toFirestore(mapToFlattenedDoc(this, data, merge));

    // Ensure document exists
    // This costs one write operation at startup only
    await this.parent.ensureDocument();

    await this.doc.update(out);
  }

  isEqual(other: DeepReference<T>) {
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
};
