import type { OrderByDirection, FieldPath, FirestoreDataConverter } from '@google-cloud/firestore';
import type { FirestoreFilter, StrapiOrFilter, StrapiWhereFilter } from '../types';
import type { DeepReference } from './deep-reference';
import type { FirestoreConnectorModel } from '../model';
import type { Snapshot } from './reference';
import type { NormalReference } from './normal-reference';
import type { ReadRepository } from '../utils/read-repository';
import { VirtualReference } from './virtual-reference';


export interface QuerySnapshot<T extends object> {
  docs: Snapshot<T>[]
  empty: boolean
}


export interface Queryable<T extends object> {
  get(trans?: ReadRepository): Promise<QuerySnapshot<T>>;
  
  where(filter: StrapiWhereFilter | StrapiOrFilter | FirestoreFilter): Queryable<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): Queryable<T>;
  limit(limit: number): Queryable<T>;
  offset(offset: number): Queryable<T>;
}

export interface Collection<T extends object> extends Queryable<T> {
  readonly model: FirestoreConnectorModel<T>
  readonly path: string
  readonly converter: FirestoreDataConverter<any>
  
  autoId(): string;
  doc(): NormalReference<T> | DeepReference<T> | VirtualReference<T>;
  doc(id: string): NormalReference<T> | DeepReference<T> | VirtualReference<T>;

  get(repo?: ReadRepository): Promise<QuerySnapshot<T>>;
}
