import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';
import type { ManualFilter } from './convert-where';

export type Reference = DocumentReference | DeepReference;

/**
 * References a field within a document.
 * In the format: `"collection/doc/field"`
 */
export type DeepReference = string;


export interface Snapshot {
  data(): DocumentData
  ref: Reference
  id: string
  exists: boolean
}

export interface QuerySnapshot {
  docs: Snapshot[]
  empty: boolean
}


export interface QueryableCollection {
  get(trans?: Transaction): Promise<QuerySnapshot>;
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableCollection;
  whereAny(filters: ManualFilter[]): QueryableCollection;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): QueryableCollection;
  limit(limit: number): QueryableCollection;
  offset(offset: number): QueryableCollection;
}
