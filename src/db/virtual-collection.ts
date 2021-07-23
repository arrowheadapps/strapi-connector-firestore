import * as _ from 'lodash';
import { convertWhere, ManualFilter, getAtFieldPath } from '../utils/convert-where';
import { OrderByDirection, FieldPath, DocumentData } from '@google-cloud/firestore';
import type { Collection, QuerySnapshot } from './collection';
import type { Converter, DataSource, FirestoreFilter, StrapiOrFilter, StrapiWhereFilter } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { coerceModelToFirestore } from '../coerce/coerce-to-firestore';
import { coerceToModel } from '../coerce/coerce-to-model';
import type { Snapshot } from './reference';
import { VirtualReference } from './virtual-reference';

interface OrderSpec {
  field: string | FieldPath
  directionStr: OrderByDirection
}

export class VirtualCollection<T extends object = DocumentData> implements Collection<T> {

  readonly model: FirestoreConnectorModel<T>
  readonly converter: Required<Converter<T>>

  private dataSource: DataSource<T>;
  private data: Promise<{ [id: string]: T }> | undefined;

  private readonly manualFilters: ManualFilter[] = [];
  private readonly _orderBy: OrderSpec[] = [];
  private _limit?: number;
  private _offset?: number;



  constructor(model: FirestoreConnectorModel<T>)
  constructor(other: VirtualCollection<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | VirtualCollection<T>) {
    if (modelOrOther instanceof VirtualCollection) {
      // Copy the values
      this.model = modelOrOther.model;
      this.converter = modelOrOther.converter;
      this.dataSource = modelOrOther.dataSource;
      this.data = modelOrOther.data;
      this.manualFilters = modelOrOther.manualFilters.slice();
      this._orderBy = modelOrOther._orderBy.slice();
      this._limit = modelOrOther._limit;
      this._offset = modelOrOther._offset;
    } else {
      this.model = modelOrOther;
      this.dataSource = modelOrOther.options.virtualDataSource!;
      const {
        toFirestore = (value) => value,
        fromFirestore = (value) => value,
      } = modelOrOther.options.converter;
      this.converter = {
        toFirestore: data => {
          const d = coerceModelToFirestore(modelOrOther, data as T);
          return toFirestore(d);
        },
        fromFirestore: snap => {
          const d = fromFirestore(snap);
          return coerceToModel(modelOrOther, snap.id, d, null, {});
        },
      };
    }
  }

  get path(): string {
    return this.model.collectionName;
  }

  autoId() {
    return this.model.firestore.collection(this.path).doc().id
  }

  doc(): VirtualReference<T>;
  doc(id: string): VirtualReference<T>;
  doc(id?: string) {
    return new VirtualReference(id?.toString() || this.autoId(), this);
  };

  async getData(): Promise<{ [id: string]: T }> {
    if (!this.data) {
      this.data = Promise.resolve().then(() => this.dataSource.getData());
    }
    return this.data;
  }

  /**
   * Notifies the data source when the data has been updated.
   */
  async updateData() {
    // Data is modified in place on the original object instance
    await this.dataSource.setData(await this.getData());
  }

  async get(): Promise<QuerySnapshot<T>> {
    const virtualData = await this.getData();

    let docs: Snapshot<T>[] = [];
    for (const [id, rawData] of Object.entries(virtualData)) {
      // Must match every 'AND' filter (if any exist)
      // and at least one 'OR' filter (if any exists)
      const data = rawData ? this.converter.fromFirestore(rawData) : undefined;
      const snap: Snapshot<T> = {
        id,
        ref: new VirtualReference(id, this),
        exists: data != null,
        data: () => data,
      };
      if (this.manualFilters.every(f => f(snap))) {
        docs.push(snap);
      }
    }

    for (const { field, directionStr } of this._orderBy) {
      docs = _.orderBy(docs, d => getAtFieldPath(this.model, field, d), directionStr);
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

  where(clause: StrapiWhereFilter | StrapiOrFilter | FirestoreFilter): VirtualCollection<T> {
    const filter = convertWhere(this.model, clause, 'manualOnly');
    if (!filter) {
      return this;
    }
    const other = new VirtualCollection(this);
    other.manualFilters.push(filter);
    return other;
  }

  orderBy(field: string | FieldPath, directionStr: OrderByDirection = 'asc'): VirtualCollection<T> {
    const other = new VirtualCollection(this);
    other._orderBy.push({ field, directionStr });
    return other;
  }

  limit(limit: number): VirtualCollection<T> {
    const other = new VirtualCollection(this);
    other._limit = limit;
    return other;
  }

  offset(offset: number): VirtualCollection<T> {
    const other = new VirtualCollection(this);
    other._offset = offset;
    return other;
  }
}
