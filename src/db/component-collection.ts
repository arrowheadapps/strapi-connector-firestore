import type { CollectionReference } from '@google-cloud/firestore';
import type { FirestoreConnectorModel } from '../model';
import type { Collection } from './collection';


export class ComponentCollection<T extends object = never> implements Collection<T> {

  private collection: CollectionReference
  constructor(readonly model: FirestoreConnectorModel<T>) {
    this.collection = model.firestore.collection(model.collectionName);
  }

  private throw(): never {
    throw new Error(
      'Operations are not supported on component collections. ' +
      'This connector embeds components directly into the parent document.'
    );
  }

  get converter() {
    return this.throw();
  }

  get path() {
    return this.throw();
  }

  autoId(): string {
    // This is used to generate IDs for components
    return this.collection.doc().id;
  }
  
  doc() {
    return this.throw();
  }

  get() {
    return this.throw();
  }

  where() {
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
