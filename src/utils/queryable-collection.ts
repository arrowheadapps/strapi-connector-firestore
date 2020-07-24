import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, Transaction, FieldPath, WhereFilterOp, DocumentSnapshot, WriteResult, SetOptions, Precondition } from '@google-cloud/firestore';
import type { StrapiWhereOperator, FirestoreConnectorModel } from '../types';
import type { ManualFilter } from './convert-where';
import * as path from 'path';

export type Reference<T = DocumentData> = DocumentReference<T> | DeepReference<T>;

/**
 * References a field within a document.
 * In the format: `"collection/doc/field"`
 */
export class DeepReference<T = DocumentData> {

  constructor(readonly doc: DocumentReference<T>, readonly id: string) {
    if (!id) {
      throw new Error('Document ID must not be empty');
    }
  }

  static parse(path: string, targetModel: FirestoreConnectorModel) {
    
    const lastSlash = path.lastIndexOf('/');
    const id = path.slice(lastSlash + 1);
    if ((lastSlash === -1) || !id) {
      throw new Error('Reference has invalid format');
    }
    targetModel.firestore.doc()
    const doc = instance.doc(ref.slice(0, lastSlash));

    return new DeepReference(doc, id);
  }

  get path() {
    return path.posix.join(this.doc.path, this.id);
  }


  get firestore() {
    return this.doc.firestore;
  }

  get parent(): QueryableCollection;

  collection(collectionPath: string): QueryableCollection<DocumentData>;

  listCollections(): Promise<Array<QueryableCollection<DocumentData>>>;

  create(data: T): Promise<WriteResult>;
  set(data: Partial<T>, options: SetOptions): Promise<WriteResult>;
  set(data: T): Promise<WriteResult>;
  update(data: Partial<T>, precondition?: Precondition): Promise<WriteResult>;
  update(field: string | FieldPath, value: any, ...moreFieldsOrPrecondition: any[]): Promise<WriteResult>;
  delete(precondition?: Precondition): Promise<WriteResult>;
  get(): Promise<DocumentSnapshot<T>>;

  /**
   * Allow serialising to JSON.
   */
  toJSON() {
    return this.path;
  }

  /**
   * Allow serialising to Firestore.
   */
  toProto() {
    return {
      stringValue: this.path
    };
  }
};


export interface Snapshot<T = DocumentData> {
  data(): T | undefined
  ref: Reference<T>
  id: string
  exists: boolean
}

export interface QuerySnapshot<T = DocumentData> {
  docs: Snapshot<T>[]
  empty: boolean
}


export interface QueryableCollection<T = DocumentData> {
  get(trans?: Transaction): Promise<QuerySnapshot<T>>;
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableCollection<T>;
  whereAny(filters: ManualFilter[]): QueryableCollection<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): QueryableCollection<T>;
  limit(limit: number): QueryableCollection<T>;
  offset(offset: number): QueryableCollection<T>;
}
