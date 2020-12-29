import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, FieldPath, WhereFilterOp, Transaction } from '@google-cloud/firestore';
import type { StrapiWhereOperator, } from '../types';
import type { ManualFilter, WhereFilter } from './convert-where';
import type { DeepReference } from './deep-reference';

export type Reference<T extends object = DocumentData> = DocumentReference<T> | DeepReference<T>;


export interface Snapshot<T extends object = DocumentData> {
  data(): T | undefined
  ref: Reference<T>
  id: string
  exists: boolean
}

export interface QuerySnapshot<T extends object = DocumentData> {
  docs: Snapshot<T>[]
  empty: boolean
}


export interface Queryable<T extends object = DocumentData> {
  get(trans?: Transaction): Promise<QuerySnapshot<T>>;
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): Queryable<T>;
  where(filter: WhereFilter): Queryable<T>;
  whereAny(filters: ManualFilter[]): Queryable<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): Queryable<T>;
  limit(limit: number): Queryable<T>;
  offset(offset: number): Queryable<T>;
}

export interface QueryableCollection<T extends object = DocumentData> extends Queryable<T> {
  readonly path: string
  
  autoId(): string;
  doc(): Reference<T>;
  doc(id: string): Reference<T>;
}
