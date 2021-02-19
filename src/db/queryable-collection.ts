import type { OrderByDirection, FieldPath, FirestoreDataConverter } from '@google-cloud/firestore';
import type { Model, ModelData, OrClause, WhereClause } from 'strapi';
import type { FirestoreFilter } from '../utils/convert-where';
import type { DeepReference } from './deep-reference';
import type { Snapshot } from './reference';
import type { NormalReference } from './normal-reference';
import type { ReadRepository } from '../utils/read-repository';


export interface QuerySnapshot<T extends ModelData> {
  docs: Snapshot<T>[]
  empty: boolean
}


export interface Queryable<T extends ModelData> {
  get(trans?: ReadRepository): Promise<QuerySnapshot<T>>;
  
  where(filter: WhereClause | OrClause | FirestoreFilter): Queryable<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): Queryable<T>;
  limit(limit: number): Queryable<T>;
  offset(offset: number): Queryable<T>;
}

export interface QueryableCollection<T extends ModelData> extends Queryable<T> {
  readonly model: Model<T>
  readonly path: string
  readonly converter: FirestoreDataConverter<any>
  
  autoId(): string;
  doc(): NormalReference<T> | DeepReference<T>;
  doc(id: string): NormalReference<T> | DeepReference<T>;
}
