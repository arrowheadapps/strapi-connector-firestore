import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, FieldPath, WhereFilterOp, Transaction } from '@google-cloud/firestore';
import type { StrapiWhereOperator, } from '../types';
import type { ManualFilter, WhereFilter } from './convert-where';
import type { DeepReference } from './deep-reference';
import type { MorphReference } from './morph-reference';

export type Reference<T extends object = DocumentData> = DocumentReference<T> | DeepReference<T> | MorphReference<T>;

export function refEquals(a: Reference<any> | null | undefined, b: Reference<any> | null | undefined): boolean {
  if (a == b) {
    // I.e. both are `null` or `undefined`, or
    // the exact same instance
    return true;
  }

  if (a) {
    return a.isEqual(b as any);
  }
  
  return false;
}

/**
 * The shape of references as stored in Firestore.
 */
export type ReferenceShape<T extends object> = 
  DocumentReference<T> |
  FlatReferenceShape<T> |
  MorphReferenceShape<T>;

export interface FlatReferenceShape<T extends object> {
  ref: DocumentReference<{ [id: string]: T }>
  id: string
}

export type MorphReferenceShape<T extends object> = NormalMorphReferenceShape<T> | FlatMorphReferenceShape<T>;

export interface NormalMorphReferenceShape<T extends object> {
  ref: DocumentReference<T>
  filter: string | null
}

export interface FlatMorphReferenceShape<T extends object> extends FlatReferenceShape<T> {
  filter: string | null
}



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
  doc(): DocumentReference<T> | DeepReference<T>;
  doc(id: string): DocumentReference<T> | DeepReference<T>;
}
