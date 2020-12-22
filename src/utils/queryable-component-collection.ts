import { CollectionReference } from '@google-cloud/firestore';
import { FirestoreConnectorModel } from '../model';
import type { QueryableCollection } from './queryable-collection';


export class QueryableComponentCollection<T = never> implements QueryableCollection<T> {

  private dummyCollection: CollectionReference
  constructor(model: FirestoreConnectorModel<T>) {
    this.dummyCollection = model.firestore.collection(model.collectionName);
  }

  private throw(): never {
    throw new Error(
      'Operations are not supported on component collections. ' +
      'This connector embeds components directly into the parent document.'
    );
  }


  get path() {
    return this.throw();
  }

  autoId(): string {
    // This is used to generate IDs for components
    return this.dummyCollection.doc().id;
  }
  
  doc() {
    return this.throw();
  }

  create() {
    return this.throw();
  }

  update() {
    return this.throw();
  }

  setMerge() {
    return this.throw();
  }

  delete() {
    return this.throw();
  }

  get() {
    return this.throw();
  }

  where() {
    return this.throw();
  }

  whereAny() {
    return this.throw();
  }

  orderBy() {
    return this.throw();
  }

  limit() {
    return this.throw();
  }

  offset() {
    return this.throw();
  }
}
