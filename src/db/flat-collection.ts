import * as _ from 'lodash';
import * as path from 'path';
import { convertWhere } from '../utils/convert-where';
import { DocumentReference, OrderByDirection, FieldPath, DocumentData, FirestoreDataConverter } from '@google-cloud/firestore';
import type { Collection, QuerySnapshot } from './collection';
import type { FirestoreFilter, StrapiOrFilter, StrapiWhereFilter } from '../types';
import { DeepReference } from './deep-reference';
import type { FirestoreConnectorModel } from '../model';
import { coerceModelToFirestore, coerceToFirestore } from '../coerce/coerce-to-firestore';
import { coerceToModel } from '../coerce/coerce-to-model';
import type { ReadRepository } from '../utils/read-repository';
import { applyManualFilters, ManualFilter, OrderSpec } from '../utils/manual-filter';


export class FlatCollection<T extends object = DocumentData> implements Collection<T> {

  readonly model: FirestoreConnectorModel<T>
  readonly document: DocumentReference<{ [id: string]: T }>;
  readonly converter: FirestoreDataConverter<{ [id: string]: T }>;

  private readonly manualFilters: ManualFilter[] = [];
  private readonly _orderBy: OrderSpec[] = [];
  private _limit?: number;
  private _offset?: number;

  private _ensureDocument: Promise<any> | null;


  constructor(model: FirestoreConnectorModel<T>)
  constructor(other: FlatCollection<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | FlatCollection<T>) {
    if (modelOrOther instanceof FlatCollection) {
      // Copy the values
      this.model = modelOrOther.model;
      this.document = modelOrOther.document;
      this.converter = modelOrOther.converter;
      this._ensureDocument = modelOrOther._ensureDocument;
      this.manualFilters = modelOrOther.manualFilters.slice();
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
            const { fieldPath } = splitId(path);
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
            const { id, fieldPath } = splitId(path);
            return coerceToModel(modelOrOther, id, fromFirestore(d), fieldPath, {});
          });
        },
      };

      const docPath = path.posix.join(modelOrOther.collectionName, modelOrOther.options.singleId);
      this.document = modelOrOther.firestore
        .doc(docPath)
        .withConverter(this.converter);
    }
  }

  get path(): string {
    return this.document.parent.path;
  }

  autoId() {
    return this.document.parent.doc().id;
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
      this._ensureDocument = this.document.set({}, { merge: true })
        .catch((err) => {
          this._ensureDocument = null;
          throw err;
        });
    }
    return this._ensureDocument;
  }

  async get(repo?: ReadRepository): Promise<QuerySnapshot<T>> {
    const snap = repo
      ? (await repo.getAll([{ ref: this.document }]))[0]
      : await this.document.get();

    return applyManualFilters({
      model: this.model,
      data: snap.data() || {},
      filters: this.manualFilters,
      orderBy: this._orderBy,
      limit: this._limit,
      offset: this._offset,
    });
  }

  where(clause: StrapiWhereFilter | StrapiOrFilter | FirestoreFilter): FlatCollection<T> {
    const filter = convertWhere(this.model, clause, 'manualOnly');
    if (!filter) {
      return this;
    }
    const other = new FlatCollection(this);
    other.manualFilters.push(filter);
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): FlatCollection<T> {
    const other = new FlatCollection(this);
    other._orderBy.push({ field, directionStr });
    return other;
  }

  limit(limit: number): FlatCollection<T> {
    const other = new FlatCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): FlatCollection<T> {
    const other = new FlatCollection(this);
    other._offset = offset;
    return other;
  }
}

function splitId(path: string): { id: string, fieldPath: string | null } {
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