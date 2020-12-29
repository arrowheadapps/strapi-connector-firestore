import * as _ from 'lodash';
import * as path from 'path';
import { DocumentData, DocumentReference, FieldValue, SetOptions, Transaction } from "@google-cloud/firestore";
import type { Snapshot } from "./queryable-collection";
import type { QueryableFlatCollection } from './queryable-flat-collection';
import { mapToFlattenedDoc } from './map-to-flattened-doc';

/**
 * References an item in a flattened collection 
 * (i.e.) a field within a document.
 */
export class DeepReference<T extends object = DocumentData> {

  readonly doc: DocumentReference<Record<string, T>>

  constructor(readonly id: string, readonly parent: QueryableFlatCollection<T>) {
    if (!id) {
      throw new Error('Document ID must not be empty');
    }

    this.doc = parent.flatDoc;
  }

  static parse(path: string): DeepReference {
    if (typeof path !== 'string') {
      throw new Error(`Can only parse a DeepReference from a string, received: "${typeof path}".`);
    }
    if (!path.startsWith('/')) {
      throw new Error('Reference has invalid format');
    }

    // A deep reference is in the format
    // /{collectionPath}/{docId}/{id}
    // e.g.
    //  - "/collectionName/default/abcd123"
    //  - "/collectionName/defg456/subCollection/default/abcd123"
    
    const lastSlash = path.lastIndexOf('/');
    const secondToLastSlash = path.lastIndexOf('/', lastSlash - 1);
    const id = path.slice(lastSlash + 1);
    const targetCollectionName = path.slice(1, secondToLastSlash);
    if ((lastSlash === -1) || (secondToLastSlash === -1) || !id || !targetCollectionName) {
      throw new Error('Reference has invalid format');
    }

    const targetModel = strapi.db.getModelByCollectionName(targetCollectionName);
    if (!targetModel) {
      throw new Error(`Could not find model referred to by "${targetCollectionName}"`);
    }

    return targetModel.db.doc(id) as DeepReference;
  }

  get path() {
    return path.posix.join(this.doc.path, this.id);
  }


  get firestore() {
    return this.doc.firestore;
  }

  async delete(transaction?: Transaction) {
    await this._set(FieldValue.delete(), transaction, false);
  };

  async create(data: T, transaction?: Transaction) {
    // TODO:
    // Error if document already exists
    await this._set(data, transaction, false);
  };

  async update(data: Partial<T>, transaction?: Transaction) {
    // TODO:
    // Error if document doesn't exist
    await this._set(data, transaction, false);
  };

  set(data: T, transaction?: Transaction): Promise<void>
  set(data: Partial<T>, options: SetOptions, transaction?: Transaction): Promise<void>
  async set(data: Partial<T>, optionsOrTrans?: SetOptions | Transaction, trans?: Transaction) {
    if (optionsOrTrans instanceof Transaction) {
      await this._set(data, optionsOrTrans, false);
    } else {
      await this._set(data, trans, optionsOrTrans?.merge || false);
    }
  }

  
  private async _set(data: any, trans: Transaction | undefined, merge: boolean) {

    data = mapToFlattenedDoc(this.id, data, merge);

    // HACK:
    // It seems that Firestore does not call the converter
    // for update operations?
    data = this.parent.conv.toFirestore(data);

    // Ensure document exists
    // This costs one write operation at startup only
    await this.parent.ensureDocument();

    if (trans) {
      trans.update(this.doc, data);
    } else {
      await this.doc.update(data);
    }
  }

  async get(transaction?: Transaction): Promise<Snapshot<T>> {
    const snap = await (transaction ? transaction.get(this.doc) : this.doc.get());
    const data = snap.data()?.[this.id];

    return {
      ref: this,
      data: () => data,
      id: this.id,
      exists: data !== undefined,
    };
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
    return this.toFirestoreValue();
  }

  /**
   * Returns a value that can be serialised
   * to Firestore.
   */
  toFirestoreValue() {
    return '/' + this.path;
  }

  toString() {
    return this.toFirestoreValue();
  }
};
