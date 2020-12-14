/**
 * Implementation of model queries for mongo
 */

import * as _ from 'lodash';
import { populateDoc, populateDocs } from './populate';
import { convertRestQueryParams } from 'strapi-utils';
import type { StrapiQueryParams, StrapiFilter, StrapiQuery, StrapiAttributeType } from './types';
import { StatusError } from './utils/status-error';
import { deleteRelations, updateRelations } from './relations';
import { FieldPath } from '@google-cloud/firestore';
import { validateComponents } from './utils/validate-components';
import { TransactionWrapper } from './utils/transaction-wrapper';
import type { Snapshot, QueryableCollection, Reference } from './utils/queryable-collection';
import { ManualFilter, convertWhere } from './utils/convert-where';
import { coerceAttribute, toFirestore } from './utils/coerce';
import { buildPrefixQuery } from './utils/prefix-query';



export function queries({ model, modelKey, strapi }: StrapiQueryParams) {
  

  function buildSearchQuery(value: any, query: QueryableCollection) {

    if (model.options.searchAttribute) {
      const field = model.options.searchAttribute;
      const type: StrapiAttributeType = (field === model.primaryKey)
        ? 'uid'
        : model.attributes[field].type;

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
          value = coerceAttribute(model.attributes[field], value, toFirestore);
          return query.where(convertWhere(field, 'eq', value, 'nativeOnly'));

        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          // Use prefix operator
          value = coerceAttribute(model.attributes[field], value, toFirestore);
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

      Object.keys(model.attributes).forEach((field) => {
        const attr = model.attributes[field];
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

  function buildFirestoreQuery(params, searchQuery: string | null, query: QueryableCollection): QueryableCollection | null {
    // Remove any search query
    // because we extract and handle it separately
    // Otherwise `convertRestQueryParams` will also handle it
    delete params._q;
    const filters: StrapiFilter = convertRestQueryParams(params);

    if (searchQuery) {
      query = buildSearchQuery(searchQuery, query);
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
        if (model.attributes[field]?.type === 'password') {
          throw new Error('Not allowed to query password fields');
        }

        // Coerce to the appropriate types
        // Because values from querystring will always come in as strings
        
        if ((field === model.primaryKey) || (field === 'id')) {
          // Detect and enable filtering on document ID
          // FIXME:
          // Does the value need to be coerceed to a DocumentReference? 
          value = _.isArray(value)
            ? value.map(v => v?.toString())
            : value?.toString();
          field = FieldPath.documentId();

        } else if (operator !== 'null') {
          // Don't coerce the 'null' operatore because the value is true/false
          // not the type of the field
          value = coerceAttribute(model.attributes[field], value, toFirestore);
        }

        query = query.where(field, operator, value);
      }
    }


    (filters.sort || []).forEach(({ field, order }) => {
      if (_.includes(model.idKeys, field)) {
        query = query.orderBy(FieldPath.documentId() as any, order);
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

  async function runFirestoreQuery(params, searchQuery: string | null, transaction: TransactionWrapper | undefined) {
    const query = buildFirestoreQuery(params, searchQuery, model.db);
    if (!query) {
      return [];
    }

    const result = await (transaction ? transaction.get(query) : query.get());
    return result.docs;
  }




  async function find(params: any, populateFields?: string[]) {
    const populateOpt = populateFields || model.defaultPopulate;

    return await model.runTransaction(async trans => {
      let docs: Snapshot[];
      if (model.hasPK(params)) {
        const ref = model.doc(model.getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(params, null, trans);
      }

      return await populateDocs(model, docs, populateOpt, trans);
    });
  }

  async function findOne(params: any, populateFields?: string[]) {
    const entries = await find({ ...params, _limit: 1 }, populateFields);
    return entries[0] || null;
  }

  async function count(params: any): Promise<number> {
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(params, null, undefined);
    return docs.length;
  }

  async function create(values: any, populate?: string[]) {
    const populateOpt = populate || model.defaultPopulate;

    // Validate components dynamiczone
    const components = validateComponents(values, model);

    // Extract values related to relational data.
    const relations = model.pickRelations(values);
    const data = model.omitExernalValues(values);

    // Add timestamp data
    if (_.isArray(model.options.timestamps)) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = model.options.timestamps;
      data[createdAtKey] = now;
      data[updatedAtKey] = now;
    }

    // Create entry without relational data
    const id = model.getPK(values);
    const ref = id ? model.doc(id) : model.doc();

    return await model.runTransaction(async trans => {
      
      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await updateRelations(model, {
          values: model.pickRelations(value),
          data: value,
          ref
        }, trans);
      }));
      
      // Update relations
      await updateRelations(model, {
        values: relations,
        data,
        ref
      }, trans);
      
      // Populate relations
      const entry = await populateDoc(model, { ref, data: () => data }, populateOpt, trans);

      await model.create(ref, data, trans);
      return entry;
    });
  }

  async function update(params: any, values: any, merge = false, populateFields?: string[]) {
    const populateOpt = populateFields || model.defaultPopulate;

    // Validate components dynamiczone
    const components = validateComponents(values, model);

    // Extract values related to relational data.
    const relations = model.pickRelations(values);
    const data = model.omitExernalValues(values);

    // Add timestamp data
    if (_.isArray(model.options.timestamps)) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = model.options.timestamps;

      // Prevent creation timestamp from being overwritten
      delete data[createdAtKey];
      data[updatedAtKey] = now;
    }

    // Run the transaction
    return await model.runTransaction(async trans => {

      let ref: Reference;
      if (model.hasPK(params)) {
        ref = model.doc(model.getPK(params));
      } else {
        const docs = await runFirestoreQuery({ ...params, _limit: 1 }, null, trans);
        if (!docs.length) {
          throw new StatusError('entry.notFound', 404);
        }

        ref = docs[0].ref;
      }


      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await updateRelations(model, {
          values: model.pickRelations(value),
          data: value,
          ref
        }, trans);
      }));

      // Update relations
      await updateRelations(model, {
        values: relations,
        data,
        ref
      }, trans);

      // Populate relations
      const entry = await populateDoc(model, { ref, data: () => data }, populateOpt, trans);

      // Update entry without relational data.
      if (merge) {
        await model.setMerge(ref, data, trans);
      } else {
        await model.update(ref, data, trans);
      }

      return entry;

    });
  }

  async function deleteMany(params: any, populate?: string[]) {
    if (model.hasPK(params)) {
      return await deleteOne(model.getPK(params), populate)
    } else {
      // TODO: FIXME: Running multiple deletes at the same time
      // Deletes may affect many relations
      // All are transacted so they all may interfere with eachother
      // Should run in the same transaction
      const entries = await find(params);
      return Promise.all(entries.map(entry => deleteOne(entry[model.primaryKey], populate)));
    }
  }

  async function deleteOne(id: string, populateFields: string[] | undefined) {
    const populateOpt = populateFields || model.defaultPopulate;

    return await model.runTransaction(async trans => {

      const ref = model.doc(id);
      const snap = await trans.get(ref);
      const entry = snap.data();
      if (!entry) {
        throw new StatusError('entry.notFound', 404);
      }

      const doc = await populateDoc(model, snap, populateOpt, trans);

      await deleteRelations(model, { entry: doc, ref }, trans);

      await model.delete(ref, trans);
      return doc;
    });
  }

  async function search(params: any, populate?: string[]) {
    const populateOpt = populate || model.defaultPopulate;

    return await model.runTransaction(async trans => {
      let docs: Snapshot[];
      if (model.hasPK(params)) {
        const ref = model.doc(model.getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(params, params._q, trans);
      }

      return await populateDocs(model, docs, populateOpt, trans);
    });
  }

  async function countSearch(params: any) {
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(params, params._q, undefined);
    return docs.length;
  }

  const queries: StrapiQuery = {
    findOne,
    find,
    create,
    update,
    delete: deleteMany,
    count,
    search,
    countSearch,
  };
  return queries;
};
