import * as _ from 'lodash';
import { convertWhere } from '../utils/convert-where';
import { OrderByDirection, FieldPath, DocumentData } from '@google-cloud/firestore';
import type { Collection, QuerySnapshot } from './collection';
import type { Converter, DataSource, FirestoreFilter, StrapiOrFilter, StrapiWhereFilter } from '../types';
import type { FirestoreConnectorModel } from '../model';
import { coerceModelToFirestore } from '../coerce/coerce-to-firestore';
import { coerceToModel } from '../coerce/coerce-to-model';
import { VirtualReference } from './virtual-reference';
import { applyManualFilters, ManualFilter, OrderSpec } from '../utils/manual-filter';


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
    if (this.dataSource.setData) {
      await this.dataSource.setData(await this.getData());
    }
  }

  async get(): Promise<QuerySnapshot<T>> {
    return applyManualFilters({
      model: this.model,
      data: await this.getData(),
      filters: this.manualFilters,
      orderBy: this._orderBy,
      limit: this._limit,
      offset: this._offset,
    });
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
