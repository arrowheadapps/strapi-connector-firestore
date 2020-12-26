import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { populateDoc, populateDocs } from './populate';
import { relationsDelete, relationsUpdate } from './relations';
import { coerceAttribute, toFirestore } from './utils/coerce';
import { convertWhere, ManualFilter } from './utils/convert-where';
import { buildPrefixQuery } from './utils/prefix-query';
import { StatusError } from './utils/status-error';
import { validateComponents } from './utils/validate-components';
import type { FirestoreConnectorModel } from './model';
import type { StrapiQuery, StrapiAttributeType, StrapiFilter, AttributeKey } from './types';
import type { Queryable, Snapshot } from './utils/queryable-collection';
import type { TransactionWrapper } from './utils/transaction-wrapper';


export interface FirestoreConnectorQueryArgs {
  model: FirestoreConnectorModel<any>
}

/**
 * Firestore connector implementation of the Strapi query interface.
 */
export class FirestoreConnectorQuery<T extends object> implements StrapiQuery<T> {

  readonly model: FirestoreConnectorModel<T>

  constructor({ model }: FirestoreConnectorQueryArgs) {
    this.model = model;
  }

  
  async find(params: any, populate?: AttributeKey<T>[]): Promise<T[]> {
    const populateOpt = populate || this.model.defaultPopulate;

    return await this.model.runTransaction(async trans => {
      let docs: Snapshot<T>[];
      if (this.model.hasPK(params)) {
        const ref = this.model.db.doc(this.model.getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await this.runFirestoreQuery(params, null, trans);
      }

      return await populateDocs(this.model, docs, populateOpt, trans);
    });
  }

  async findOne(params: any, populate?: AttributeKey<T>[]): Promise<T | null> {
    const entries = await this.find({ ...params, _limit: 1 }, populate);
    return entries[0] || null;
  }

  async count(params: any): Promise<number> {
    // Don't populate any fields, we are just counting
    const docs = await this.runFirestoreQuery(params, null, null);
    return docs.length;
  }

  async create(values: any, populate?: AttributeKey<T>[]): Promise<T> {
    const populateOpt = populate || this.model.defaultPopulate;

    // Validate components dynamiczone
    const components = validateComponents(values, this.model);

    // Add timestamp data
    if (this.model.timestamps) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = this.model.timestamps;
      values[createdAtKey] = now;
      values[updatedAtKey] = now;
    }

    // Create entry without relational data
    const id = this.model.getPK(values);
    const ref = id ? this.model.db.doc(id) : this.model.db.doc();

    return await this.model.runTransaction(async trans => {
      
      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await relationsUpdate(this.model, ref, undefined, value, trans);
      }));
      
      // Update relations
      await relationsUpdate(this.model, ref, undefined, values, trans);
      
      // Populate relations
      const entry = await populateDoc(this.model, { ref, data: () => values }, populateOpt, trans);

      await this.model.db.create(ref, values, trans);
      return entry;
    });
  }

  async update(params: any, values: any, populate?: AttributeKey<T>[], merge = false): Promise<T> {
    const populateOpt = populate || this.model.defaultPopulate;

    // Validate components dynamiczone
    const components = validateComponents(values, this.model);

    // Add timestamp data
    if (this.model.timestamps) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = this.model.timestamps;

      // Prevent creation timestamp from being overwritten
      delete values[createdAtKey];
      values[updatedAtKey] = now;
    }

    // Run the transaction
    return await this.model.runTransaction(async trans => {

      let snap: Snapshot<T>;
      if (this.model.hasPK(params)) {
        snap = await trans.get(this.model.db.doc(this.model.getPK(params)));
      } else {
        const docs = await this.runFirestoreQuery({ ...params, _limit: 1 }, null, trans);
        snap = docs[0];
      }

      const prevData = snap.data();
      if (!prevData) {
        throw new StatusError('entry.notFound', 404);
      }


      // Update components
      await Promise.all(components.map(async ({ model, key, value }) => {
        const prevValue = _.castArray(_.get(prevData, key)).find(c => model.getPK(c) === model.getPK(value));
        await relationsUpdate(model, snap.ref, prevValue, value, trans);
      }));

      // Update relations
      await relationsUpdate(this.model, snap.ref, prevData, values, trans);

      // Populate relations
      const entry = await populateDoc(this.model, { ref: snap.ref, data: () => values }, populateOpt, trans);

      // Update entry without
      if (merge) {
        await this.model.db.setMerge(snap.ref, values, trans);
      } else {
        await this.model.db.update(snap.ref, values, trans);
      }

      return entry;

    });
  }

  async delete(params: any, populate?: AttributeKey<T>[]): Promise<T[]> {
    if (this.model.hasPK(params)) {
      const result = await this.deleteOne(this.model.getPK(params), populate);
      return [result];
    } else {
      // TODO: FIXME: Running multiple deletes at the same time
      // Deletes may affect many relations
      // All are transacted so they all may interfere with eachother
      // Should run in the same transaction
      const entries = await this.find(params);
      return Promise.all(entries.map(entry => this.deleteOne(this.model.getPK(entry), populate)));
    }
  }

  async search(params: any, populate?: AttributeKey<T>[]): Promise<T[]> {
    const populateOpt = populate || this.model.defaultPopulate;

    return await this.model.runTransaction(async trans => {
      let docs: Snapshot<T>[];
      if (this.model.hasPK(params)) {
        const ref = this.model.db.doc(this.model.getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await this.runFirestoreQuery(params, params._q, trans);
      }

      return await populateDocs(this.model, docs, populateOpt, trans);
    });
  }

  async countSearch(params: any): Promise<number> {
    // Don't populate any fields, we are just counting
    const docs = await this.runFirestoreQuery(params, params._q, null);
    return docs.length;
  }



  private async deleteOne(id: string, populate: AttributeKey<T>[] | undefined): Promise<T> {
    const populateOpt = populate || this.model.defaultPopulate;

    return await this.model.runTransaction(async trans => {

      const ref = this.model.db.doc(id);
      const snap = await trans.get(ref);
      const data = snap.data();
      if (!data) {
        throw new StatusError('entry.notFound', 404);
      }

      const doc = await populateDoc(this.model, snap, populateOpt, trans);

      await relationsDelete(this.model, ref, data, trans);

      await this.model.db.delete(ref, trans);
      return doc;
    });
  }

  

  private buildSearchQuery(value: any, query: Queryable<T>) {

    if (this.model.options.searchAttribute) {
      const field = this.model.options.searchAttribute;
      const type: StrapiAttributeType = (field === this.model.primaryKey)
        ? 'uid'
        : this.model.attributes[field].type;

      // Build a native implementation of primitive search
      switch (type) {
        case 'integer':
        case 'float':
        case 'decimal':
        case 'biginteger':
        case 'date':
        case 'time':
        case 'datetime':
        case 'timestamp':
        case 'json':
        case 'boolean':
          // Use equality operator 
          value = coerceAttribute(this.model.attributes[field], value, toFirestore);
          return query.where(convertWhere(field, 'eq', value, 'nativeOnly'));

        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          // Use prefix operator
          value = coerceAttribute(this.model.attributes[field], value, toFirestore);
          const { gte, lt } = buildPrefixQuery(value);
          return query
            .where(convertWhere(field, 'gte', gte, 'nativeOnly'))
            .where(convertWhere(field, 'lt', lt, 'nativeOnly'));

        case 'password':
          // Explicitly don't search in password fields
          throw new Error('Not allowed to query password fields');
          
        default:
          throw new Error(`Search attribute "${field}" is an of an unsupported type`);
      }

    } else {

      // Build a manual implementation of fully-featured search
      const filters: ManualFilter[] = [];

      if (value != null) {
        filters.push(convertWhere(FieldPath.documentId(), 'contains', value.toString(), 'manualOnly'));
      }

      Object.keys(this.model.attributes).forEach((field) => {
        const attr = this.model.attributes[field];
        switch (attr.type) {
          case 'integer':
          case 'float':
          case 'decimal':
          case 'biginteger':
            try {
              // Use equality operator for numbers
              filters.push(convertWhere(field, 'eq', coerceAttribute(attr, value, toFirestore), 'manualOnly'));
            } catch {
              // Ignore if the query can't be coerced to this type
            }
            break;

          case 'string':
          case 'text':
          case 'richtext':
          case 'email':
          case 'enumeration':
          case 'uid':
            try {
              // User contains operator for strings
              filters.push(convertWhere(field, 'contains', coerceAttribute(attr, value, toFirestore), 'manualOnly'));
            } catch {
              // Ignore if the query can't be coerced to this type
            }
            break;

          case 'date':
          case 'time':
          case 'datetime':
          case 'timestamp':
          case 'json':
          case 'boolean':
          case 'password':
            // Explicitly don't search in these fields
            break;
            
          default:
            // Unsupported field type for search
            // Don't search in these fields
            break;
        }
      });

      return query.whereAny(filters);
    }
  };

  private buildFirestoreQuery(params, searchQuery: string | null, query: Queryable<T>): Queryable<T> | null {
    // Remove any search query
    // because we extract and handle it separately
    // Otherwise `convertRestQueryParams` will also handle it
    delete params._q;
    const filters: StrapiFilter = convertRestQueryParams(params);

    if (searchQuery) {
      query = this.buildSearchQuery(searchQuery, query);
    } else {
      for (const where of (filters.where || [])) {
        let { operator, value } = where;
        let field: string | FieldPath = where.field;

        if (operator === 'in') {
          value = _.castArray(value);
          if ((value as Array<any>).length === 0) {
            // Special case: empty query
            return null;
          }
        }
        if (operator === 'nin') {
          value = _.castArray(value);
          if ((value as Array<any>).length === 0) {
            // Special case: no effect
            continue;
          }
        }

        // Prevent querying passwords
        if (this.model.attributes[field]?.type === 'password') {
          throw new Error('Not allowed to query password fields');
        }

        // Coerce to the appropriate types
        // Because values from querystring will always come in as strings
        
        if ((field === this.model.primaryKey) || (field === 'id')) {
          // Detect and enable filtering on document ID
          // FIXME:
          // Does the value need to be coerceed to a DocumentReference? 
          value = Array.isArray(value)
            ? value.map(v => v?.toString())
            : value?.toString();
          field = FieldPath.documentId();

        } else if (operator !== 'null') {
          // Don't coerce the 'null' operatore because the value is true/false
          // not the type of the field
          value = coerceAttribute(this.model.attributes[field], value, toFirestore);
        }

        query = query.where(field, operator, value);
      }
    }


    (filters.sort || []).forEach(({ field, order }) => {
      if (field === this.model.primaryKey) {
        if (searchQuery || 
          (filters.where || []).some(w => w.field !== this.model.primaryKey)) {
          // Ignore sort by document ID when there are other filers
          // on fields other than the document ID
          // Document ID is the default sort for all queryies 
          // And more often than not, it interferes with Firestore inequality filter
          // or indexing rules
        } else {
          query = query.orderBy(FieldPath.documentId() as any, order);
        }
      } else {
        query = query.orderBy(field, order);
      }
    });

    if (filters.start && (filters.start > 0)) {
      query = query.offset(filters.start);
    }

    const limit = Math.max(0, filters.limit || 0);
    query = query.limit(limit);

    return query;
  }

  private async runFirestoreQuery(params, searchQuery: string | null, transaction: TransactionWrapper | null) {
    const query = this.buildFirestoreQuery(params, searchQuery, this.model.db);
    if (!query) {
      return [];
    }

    const result = await (transaction ? transaction.get(query) : query.get());
    return result.docs;
  }
}