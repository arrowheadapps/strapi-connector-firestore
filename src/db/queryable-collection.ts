import type { OrderByDirection, FieldPath, WhereFilterOp, FirestoreDataConverter } from '@google-cloud/firestore';
import type { StrapiWhereFilter, StrapiWhereOperator, } from '../types';
import type { WhereFilter } from '../utils/convert-where';
import type { DeepReference } from './deep-reference';
import type { FirestoreConnectorModel } from '../model';
import type { Snapshot } from './reference';
import type { NormalReference } from './normal-reference';
import type { ReadRepository } from '../utils/read-repository';


export interface QuerySnapshot<T extends object> {
  docs: Snapshot<T>[]
  empty: boolean
}


export interface Queryable<T extends object> {
  get(trans?: ReadRepository): Promise<QuerySnapshot<T>>;
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator, value: any): Queryable<T>;
  where(filter: StrapiWhereFilter | WhereFilter): Queryable<T>;
  whereAny(filters: (StrapiWhereFilter | WhereFilter)[]): Queryable<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): Queryable<T>;
  limit(limit: number): Queryable<T>;
  offset(offset: number): Queryable<T>;
}

export interface QueryableCollection<T extends object> extends Queryable<T> {
  readonly model: FirestoreConnectorModel<T>
  readonly path: string
  readonly converter: FirestoreDataConverter<any>
  
  autoId(): string;
  doc(): NormalReference<T> | DeepReference<T>;
  doc(id: string): NormalReference<T> | DeepReference<T>;
}
