import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator, } from '../types';
import type { ManualFilter, WhereFilter } from './convert-where';
import type { DeepReference } from './deep-reference';
import { TransactionWrapper } from './transaction-wrapper';

export type Reference<T = DocumentData> = DocumentReference<T> | DeepReference<T>;


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


export interface Queryable<T = DocumentData> {
  get(trans?: Transaction): Promise<QuerySnapshot<T>>;
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): Queryable<T>;
  where(filter: WhereFilter): Queryable<T>;
  whereAny(filters: ManualFilter[]): Queryable<T>;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): Queryable<T>;
  limit(limit: number): Queryable<T>;
  offset(offset: number): Queryable<T>;
}

export interface QueryableCollection<T = DocumentData> extends Queryable<T> {
  readonly path: string
  
  autoId(): string;
  doc(): Reference<T>;
  doc(id: string): Reference<T>;
  create(ref: Reference<T>, data: T, transaction: TransactionWrapper | undefined): Promise<void>;
  update(ref: Reference<T>, data: Partial<T>, transaction: TransactionWrapper | undefined): Promise<void>;
  setMerge(ref: Reference<T>, data: Partial<T>, transaction: TransactionWrapper | undefined): Promise<void>;
  delete(ref: Reference<T>, transaction: TransactionWrapper | undefined): Promise<void>;
}
