import * as _ from 'lodash';
import * as path from 'path';
import { convertWhere, ManualFilter, WhereFilter, getAtFieldPath } from '../utils/convert-where';
import { DocumentReference, OrderByDirection, FieldPath, WhereFilterOp, DocumentData, FirestoreDataConverter } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot } from './queryable-collection';
import type { StrapiWhereFilter, StrapiWhereOperator } from '../types';
import { DeepReference } from './deep-reference';
import type { FirestoreConnectorModel } from '../model';
import { coerceModelToFirestore, coerceToFirestore } from '../coerce/coerce-to-firestore';
import { coerceToModel } from '../coerce/coerce-to-model';
import type { Snapshot } from './reference';
import type { ReadRepository } from '../utils/read-repository';
import { mapNotNull } from '../utils/map-not-null';


export class QueryableFlatCollection<T extends object = DocumentData> implements QueryableCollection<T> {

  readonly model: FirestoreConnectorModel<T>
  readonly flatDoc: DocumentReference<{ [id: string]: T }>;
  readonly converter: FirestoreDataConverter<{ [id: string]: T }>;

  private _filters: ManualFilter[] = [];
  private _orderBy: { field: string | FieldPath, directionStr: OrderByDirection }[] = [];
  private _limit?: number
  private _offset?: number

  private _ensureDocument: Promise<any> | null;


  constructor(model: FirestoreConnectorModel<T>)
  constructor(other: QueryableFlatCollection<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | QueryableFlatCollection<T>) {
    if (modelOrOther instanceof QueryableFlatCollection) {
      // Copy the values
      this.model = modelOrOther.model;
      this.flatDoc = modelOrOther.flatDoc;
      this.converter = modelOrOther.converter;
      this._ensureDocument = modelOrOther._ensureDocument;
      this._filters = modelOrOther._filters.slice();
      this._orderBy = modelOrOther._orderBy.slice();
      this._limit = modelOrOther._limit;
      this._offset = modelOrOther._offset;
    } else {
      this.model = modelOrOther;
      this._ensureDocument = null;
      const {
        toFirestore = (value) => value,
        fromFirestore = (value) => value,
      } = modelOrOther.options.converter;
      this.converter = {
        toFirestore: data => {
          return _.mapValues(data, (d, path) => {
            // Remove the document ID component from the field path
            const { fieldPath } = spitId(path);
            if (fieldPath === modelOrOther.primaryKey) {
              return undefined;
            }

            // If the field path exists then the value isn't a root model object
            const obj: T = fieldPath ? coerceToFirestore(d) : coerceModelToFirestore(modelOrOther, d);
            return toFirestore(obj);
          });
        },
        fromFirestore: data => {
          return _.mapValues(data.data(), (d, path) => {
            const { id, fieldPath } = spitId(path);
            return coerceToModel(modelOrOther, id, fromFirestore(d), fieldPath, {});
          });
        },
      };

      const docPath = path.posix.join(modelOrOther.collectionName, modelOrOther.options.singleId);
      this.flatDoc = modelOrOther.firestore
        .doc(docPath)
        .withConverter(this.converter);
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

  async get(repo?: ReadRepository): Promise<QuerySnapshot<T>> {
    const snap = repo
      ? (await repo.getAll([{ ref: this.flatDoc }]))[0]
      : await this.flatDoc.get();

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
    }

    if (this._orderBy.length) {
      for (const { field, directionStr } of this._orderBy) {
        docs = _.sortBy(docs, d => getAtFieldPath(this.model, field, d));
        if (directionStr === 'desc') {
          docs = _.reverse(docs);
        }
      }
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

  where(filter: StrapiWhereFilter | WhereFilter): QueryableFlatCollection<T>
  where(field: string | FieldPath, operator: WhereFilterOp | StrapiWhereOperator, value: any): QueryableFlatCollection<T>
  where(fieldOrFilter: string | FieldPath | StrapiWhereFilter | WhereFilter, operator?: WhereFilterOp | StrapiWhereOperator, value?: any): QueryableFlatCollection<T> {
    if ((typeof fieldOrFilter === 'string') || (fieldOrFilter instanceof FieldPath)) {
      const other = new QueryableFlatCollection(this);
      const filter = convertWhere(this.model, fieldOrFilter, operator!, value, 'manualOnly');
      if (!filter) {
        return this;
      }
      other._filters.push(filter);
      return other;
    } else {
      return this.where(fieldOrFilter.field, fieldOrFilter.operator, fieldOrFilter.value);
    }
  }

  whereAny(filters: (StrapiWhereFilter | WhereFilter)[]): QueryableFlatCollection<T> {
    const other = new QueryableFlatCollection(this);
    const filterFns = mapNotNull(
      filters,
      ({ field, operator, value }) => {
        return convertWhere(this.model, field, operator, value, 'manualOnly');
      }
    );
    other._filters.push(data => filterFns.some(f => f(data)));
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

function spitId(path: string): { id: string, fieldPath: string | null } {
  const i = path.indexOf('.');
  if (i === -1) {
    return {
      id: path,
      fieldPath: null,
    };
  } else {
    return {
      id: path.slice(0, i),
      fieldPath: path.slice(i + 1),
    };
  }
}