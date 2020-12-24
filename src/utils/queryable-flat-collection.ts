import * as _ from 'lodash';
import * as path from 'path';
import { getFieldPath, convertWhere, ManualFilter, WhereFilter } from './convert-where';
import { DocumentReference, OrderByDirection, Transaction, FieldPath, WhereFilterOp, DocumentData, FieldValue, FirestoreDataConverter } from '@google-cloud/firestore';
import type { QueryableCollection, QuerySnapshot, Reference, Snapshot } from './queryable-collection';
import type { ConnectorOptions, StrapiWhereOperator } from '../types';
import { DeepReference } from './deep-reference';
import { coerceModelFromFirestore, coerceModelToFirestore } from './coerce';
import type { TransactionWrapper, TransactionWrapperImpl } from './transaction-wrapper';
import type { FirestoreConnectorModel } from '../model';


export class QueryableFlatCollection<T = DocumentData> implements QueryableCollection<T> {


  private readonly conv: FirestoreDataConverter<Record<string, T>>;
  private readonly flatDoc: DocumentReference<Record<string, T>>;

  private _filters: ManualFilter[] = [];
  private _orderBy: { field: string | FieldPath, directionStr: OrderByDirection }[] = [];
  private _limit?: number
  private _offset?: number

  constructor(model: FirestoreConnectorModel<T>, options: ConnectorOptions)
  constructor(other: QueryableFlatCollection<T>)
  constructor(modelOrOther: FirestoreConnectorModel<T> | QueryableFlatCollection<T>, options?: ConnectorOptions) {
    if (modelOrOther instanceof QueryableFlatCollection) {
      // Copy the values
      this.flatDoc = modelOrOther.flatDoc;
      this.conv = modelOrOther.conv;
      this._filters = modelOrOther._filters.slice();
      this._orderBy = modelOrOther._orderBy.slice();
      this._limit = modelOrOther._limit;
      this._offset = modelOrOther._offset;
    } else {
      const userConverter = modelOrOther.converter;
      this.conv = {
        toFirestore: data => _.mapValues(data, d => userConverter.toFirestore(coerceModelToFirestore(modelOrOther, d))),
        fromFirestore: data => _.mapValues(data.data(), (d, id) => coerceModelFromFirestore(modelOrOther, id, userConverter.fromFirestore(d))),
      };

      const docPath = path.posix.join(modelOrOther.collectionName, modelOrOther.options.singleId || options!.singleId);
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

  doc(): Reference<T>
  doc(id: string): Reference<T>
  doc(id?: string): Reference<T> {
    return new DeepReference(this.flatDoc, id?.toString() || this.autoId());
  };

  async delete(ref: Reference<T>, trans: TransactionWrapper | undefined) {
    await this._set(ref, FieldValue.delete(), trans, false);
  };

  async create(ref: Reference<T>, data: T, trans: TransactionWrapper | undefined) {
    // TODO:
    // Error if document already exists
    await this._set(ref, data, trans, false);
  };

  async update(ref: Reference<T>, data: Partial<T>, trans: TransactionWrapper | undefined) {
    // TODO:
    // Error if document doesn't exist
    await this._set(ref, data, trans, false);
  };


  // Set flattened document
  async setMerge(ref: Reference<T>, data: Partial<T>, trans: TransactionWrapper | undefined) {
    await this._set(ref, data, trans, true);
  };

  private _ensureDocument: Promise<any> | null = null;
  private async ensureDocument() {
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
  
  private async _set(ref: Reference<T>, data: any, trans: TransactionWrapper | undefined, merge: boolean) {
    if (!(ref instanceof DeepReference)) {
      throw new Error('Flattened collection must have reference of type `DeepReference`');
    }
    if (!ref.doc.isEqual(this.flatDoc)) {
      throw new Error('Reference points to a different model');
    }
    if (!data || (typeof data !== 'object')) {
      throw new Error(`Invalid data provided to Firestore. It must be an object but it was: ${JSON.stringify(data)}`);
    }
    
    if (FieldValue.delete().isEqual(data)) {
      data = { [ref.id]: FieldValue.delete() };
    } else {
      if (merge) {
        // Flatten into key-value pairs to merge the fields
        const pairs = _.toPairs(data);
        data = {};
        pairs.forEach(([path, val]) => {
          data[`${ref.id}.${path}`] = val;
        });
      } else {
        data = { [ref.id]: data };
      }
    }

    // Ensure document exists
    // This costs one write operation at startup only
    await this.ensureDocument();



    // HACK:
    // It seems that Firestore does not call the converter
    // for update operations?
    data = this.conv.toFirestore(data);

    if (trans) {
      // Batch all writes to documents in this flattened
      // collection and do it only once
      (trans as TransactionWrapperImpl).addKeyedWrite(this.flatDoc.path, 
        (ctx) => Object.assign(ctx || {}, data),
        (trans, ctx) => {
          trans.update(this.flatDoc, ctx);
        }
      );
    } else {
      // Do the write immediately
      await this.flatDoc.update(data);
    }
  }










  async get(trans?: Transaction): Promise<QuerySnapshot<T>> {
    const snap = await (trans ? trans.get(this.flatDoc) : this.flatDoc.get());

    let docs: Snapshot<T>[] = [];
    for (const [id, data] of Object.entries<any>(snap.data() || {})) {
      // Must match every 'AND' filter (if any exist)
      // and at least one 'OR' filter (if any exists)
      const snap: Snapshot<T> = {
        id,
        ref: new DeepReference(this.flatDoc, id),
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
