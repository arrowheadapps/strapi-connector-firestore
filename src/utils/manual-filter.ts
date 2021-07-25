import * as _ from 'lodash';
import type { FieldPath, OrderByDirection } from '@google-cloud/firestore';
import type { Snapshot } from '../db/reference';
import type { FirestoreConnectorModel } from '../model';
import type { QuerySnapshot } from '../db/collection';


export type PartialSnapshot<T extends object> = Pick<Snapshot<T>, 'id' | 'data'>;

export interface ManualFilter {
  (data: PartialSnapshot<any>): boolean
}

export interface OrderSpec {
  field: string | FieldPath
  directionStr: OrderByDirection
}

export interface ManualFilterArgs<T extends object> {
  model: FirestoreConnectorModel<T>
  data: { [id: string]: T }
  filters: ManualFilter[]
  orderBy: OrderSpec[]
  offset: number | undefined
  limit: number | undefined
}

export function applyManualFilters<T extends object>(args: ManualFilterArgs<T>): QuerySnapshot<T> {
  let docs: Snapshot<T>[] = [];
  for (const [id, data] of Object.entries(args.data)) {
    // Must match every 'AND' filter (if any exist)
    // and at least one 'OR' filter (if any exists)
    const snap: Snapshot<T> = {
      id,
      ref: args.model.db.doc(id),
      exists: data != null,
      data: () => data,
    };
    if (args.filters.every(f => f(snap))) {
      docs.push(snap);
    }
  }

  for (const { field, directionStr } of args.orderBy) {
    docs = _.orderBy(docs, d => args.model.getAttributeValue(field, d), directionStr);
  }
  
  // Offset and limit after sorting
  const offset = Math.max(args.offset || 0, 0);
  const limit = Math.max(args.limit || 0, 0) || docs.length;
  docs = docs.slice(offset, offset + limit);

  return {
    docs,
    empty: docs.length === 0
  };
}
