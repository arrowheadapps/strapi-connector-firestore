import * as _ from 'lodash';
import type { WhereFilterOp, OrderByDirection, DocumentData, DocumentReference, Firestore, Transaction } from '@google-cloud/firestore';

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
  
  where(fieldPath: string, opStr: WhereFilterOp, value: any): QueryableCollection;
  orderBy(fieldPath: string, directionStr?: OrderByDirection): QueryableCollection;
  limit(limit: number): QueryableCollection;
  offset(offset: number): QueryableCollection;
  
  search(query: string): QueryableCollection;
}
