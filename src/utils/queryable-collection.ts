import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';
import type { ManualFilter } from './convert-where';

export type Reference<T = DocumentData> = DocumentReference<T> | DeepReference;

/**
 * References a field within a document.
 * In the format: `"collection/doc/field"`
 */
export type DeepReference = string;


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
