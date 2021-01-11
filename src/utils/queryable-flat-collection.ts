import * as _ from 'lodash';
import * as path from 'path';
import { getFieldPath, convertWhere, ManualFilter, WhereFilter } from './convert-where';
import { DocumentReference, OrderByDirection, Transaction, FieldPath, WhereFilterOp, DocumentData, FirestoreDataConverter } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Snapshot } from './queryable-collection';
import type { StrapiWhereOperator } from '../types';
import { DeepReference } from './deep-reference';
import { coerceModelFromFirestore, coerceModelToFirestore } from './coerce';
import type { FirestoreConnectorModel } from '../model';


export class QueryableFlatCollection<T extends object = DocumentData> implements QueryableCollection<T> {

  readonly flatDoc: DocumentReference<{ [id: string]: T }>;
  readonly conv: FirestoreDataConverter<{ [id: string]: T }>;

  private _filters: ManualFilter[] = [];
  private _orderBy: { field: string | FieldPath, directionStr: OrderByDirection }[] = [];
  private _limit?: number
  private _offset?: number

  constructor(model: FirestoreConnectorModel<T>)
  constructor(other: QueryableFlatCollection<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | QueryableFlatCollection<T>) {
    if (modelOrOther instanceof QueryableFlatCollection) {
      // Copy the values
      this.flatDoc = modelOrOther.flatDoc;
      this.conv = modelOrOther.conv;
      this._filters = modelOrOther._filters.slice();
      this._orderBy = modelOrOther._orderBy.slice();
      this._limit = modelOrOther._limit;
      this._offset = modelOrOther._offset;
    } else {
      if (!modelOrOther.flattenedKey) {
        throw new Error(`Model "${modelOrOther.globalId}" must have a value for "flattenedKey" to build a flat collection.`);
      }

      const userConverter = modelOrOther.options.converter;
      this.conv = {
        toFirestore: data => {
          return _.mapValues(data, (d, path) => {
            const [, ...rest] = path.split('.');
            return userConverter.toFirestore(coerceModelToFirestore(modelOrOther, d, rest.join('.')));
          });
        },
        fromFirestore: data => {
          return _.mapValues(data.data(), (d, path) => {
            const [id, ...rest] = path.split('.');
            return coerceModelFromFirestore(modelOrOther, id, userConverter.fromFirestore(d), rest.join('.'));
          });
        },
      };

      const docPath = path.posix.join(modelOrOther.collectionName, modelOrOther.flattenedKey);
      this.flatDoc = modelOrOther.firestore
        .doc(docPath)
        .withConverter(this.conv);
    }
  }

  get path(): string {
    return this.flatDoc.parent.path;
  }

  autoId() {
    return this.flatDoc.parent.doc().id;
  }

  doc(): DeepReference<T>;
  doc(id: string): DeepReference<T>;
  doc(id?: string) {
    return new DeepReference(id?.toString() || this.autoId(), this);
  };


  private _ensureDocument: Promise<any> | null = null;

  /**
   * Ensures that the document containing this flat collection exists.
   * This operation is cached, so that it will happen at most once
   * for the life of the model instance.
   */
  async ensureDocument(): Promise<void> {
    // Set and merge with empty object
    // This will ensure that the document exists using
    // as single write operation
    if (!this._ensureDocument) {
      this._ensureDocument = this.flatDoc.set({}, { merge: true })
        .catch((err) => {
          this._ensureDocument = null;
          throw err;
        });
    }
    return this._ensureDocument;
  }

  async get(trans?: Transaction): Promise<QuerySnapshot<T>> {
    const snap = await (trans ? trans.get(this.flatDoc) : this.flatDoc.get());

    let docs: Snapshot<T>[] = [];
    for (const [id, data] of Object.entries<any>(snap.data() || {})) {
      // Must match every 'AND' filter (if any exist)
      // and at least one 'OR' filter (if any exists)
      const snap: Snapshot<T> = {
        id,
        ref: new DeepReference(id, this),
        exists: data != null,
        data: () => data,
      };
      if (this._filters.every(f => f(snap))) {
        docs.push(snap);
      }
    };

    if (this._orderBy.length) {
      this._orderBy.forEach(({ field, directionStr }) => {
        docs = _.sortBy(docs, d => getFieldPath(field, d));
        if (directionStr === 'desc') {
          docs = _.reverse(docs);
        }
      });
      
    }
    
    // Offset and limit after sorting
    const offset = Math.max(this._offset || 0, 0);
    const limit = Math.max(this._limit || 0, 0) || docs.length;
    docs = docs.slice(offset, offset + limit);

    return {
      docs,
      empty: docs.length === 0
    };
  }

  where(filter: WhereFilter): QueryableFlatCollection<T>
  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator | RegExp, value: any): QueryableFlatCollection<T>
  where(fieldOrFilter: string | FieldPath | WhereFilter, operator?: WhereFilterOp | StrapiWhereOperator | RegExp, value?: any): QueryableFlatCollection<T> {
    if ((typeof fieldOrFilter === 'string') || (fieldOrFilter instanceof FieldPath)) {
      const other = new QueryableFlatCollection(this);
  
      const filter = convertWhere(fieldOrFilter, operator!, value, 'manualOnly');
      other._filters.push(filter);
      return other;
    } else {
      return this.where(fieldOrFilter.field, fieldOrFilter.operator, fieldOrFilter.value);
    }
  }

  whereAny(filters: ManualFilter[]): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._filters.push(data => filters.some(f => f(data)));
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._orderBy.push({ field, directionStr });
    return other;
  }

  limit(limit: number): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    other._offset = offset;
    return other;
  }
}
