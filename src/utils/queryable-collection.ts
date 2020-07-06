import * as _ from 'lodash';
import type { OrderByDirection, DocumentData, DocumentReference, Firestore, Transaction, FieldPath, WhereFilterOp } from '@google-cloud/firestore';
import type { StrapiWhereOperator } from '../types';

export type Reference = DocumentReference | DeepReference;

/**
 * References a field within a document.
 * In the format: `"collection/doc/field"`
 */
export type DeepReference = string;

export function parseDeepReference(ref: DeepReference, instance: Firestore) {

  const lastSlash = ref.lastIndexOf('/');
  const id = ref.slice(lastSlash + 1);
  if ((lastSlash === -1) || !id) {
    throw new Error('Reference has invalid format');
  }

  const doc = instance.doc(ref.slice(0, lastSlash));

  return {
    doc,
    id,
    path: doc.path
  }
}


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
  
  where(field: string | FieldPath, opStr: WhereFilterOp | StrapiWhereOperator | RegExp, value: any, combinator?: 'and' | 'or'): QueryableCollection;
  orderBy(field: string | FieldPath, directionStr?: OrderByDirection): QueryableCollection;
  limit(limit: number): QueryableCollection;
  offset(offset: number): QueryableCollection;
}
