import * as path from 'path';
import type { DocumentData, DocumentReference } from "@google-cloud/firestore";
import type { QueryableCollection } from "./queryable-collection";

/**
 * References an item in a flattened collection 
 * (i.e.) a field within a document.
 */
export class DeepReference<T = DocumentData> {

  constructor(readonly doc: DocumentReference<Record<string, T>>, readonly id: string) {
    if (!id) {
      throw new Error('Document ID must not be empty');
    }
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

  get parent(): QueryableCollection {
    return strapi.db.getModelByCollectionName(this.doc.parent.path)!.db;
  }

  // collection(collectionPath: string): QueryableCollection<DocumentData>;
  // listCollections(): Promise<Array<QueryableCollection<DocumentData>>>;
  // create(data: T): Promise<WriteResult>;
  // set(data: Partial<T>, options: SetOptions): Promise<WriteResult>;
  // set(data: T): Promise<WriteResult>;
  // update(data: Partial<T>, precondition?: Precondition): Promise<WriteResult>;
  // update(field: string | FieldPath, value: any, ...moreFieldsOrPrecondition: any[]): Promise<WriteResult>;
  // delete(precondition?: Precondition): Promise<WriteResult>;
  // get(): Promise<Snapshot<T>>;

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
