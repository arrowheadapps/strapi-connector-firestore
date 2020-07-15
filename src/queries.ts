/**
 * Implementation of model queries for mongo
 */

import * as _ from 'lodash';
import { populateDocs } from './populate';
import { convertRestQueryParams } from 'strapi-utils';
import type { StrapiQueryParams, StrapiFilter } from './types';
import { StatusError } from './utils/status-error';
import { deleteRelations, updateRelations } from './relations';
import { FieldPath } from '@google-cloud/firestore';
import { validateComponents } from './utils/validate-components';
import { TransactionWrapper } from './utils/transaction-wrapper';
import type { Snapshot, QueryableCollection, Reference } from './utils/queryable-collection';
import { ManualFilter, convertWhere } from './utils/convert-where';
import { coerceValue } from './utils/coerce';



export function queries({ model, modelKey, strapi }: StrapiQueryParams) {
  

  function buildSearchQuery(value: any, query: QueryableCollection) {

    const filters: ManualFilter[] = [];

    if (value != null) {
      filters.push(convertWhere(FieldPath.documentId(), 'contains', value.toString(), 'manualOnly'));
    }
  
    Object.keys(model.attributes).forEach((field) => {
      switch (model.attributes[field].type) {
        case 'integer':
        case 'float':
        case 'decimal':
          const number = _.toNumber(value);
          if (!_.isNaN(number)) {
            filters.push(convertWhere(field, 'eq', number, 'manualOnly'));
          }
          break;
        
        case 'biginteger':
          try {
            const bigint = BigInt(value);
            filters.push(convertWhere(field, 'eq', bigint, 'manualOnly'));
          } catch {
          }
          break;

        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          filters.push(convertWhere(field, 'contains', value?.toString(), 'manualOnly'));
          break;

        case 'date':
        case 'time':
        case 'datetime':
        case 'json':
        case 'boolean':
        case 'password':
          // Explicitly don't search in these fields
          break;
          
        default:
          // Unsupported field type for search
          // Just ignore
          break;
      }
    });
  
    return query.whereAny(filters);
  };

  function buildFirestoreQuery(params, searchQuery: string | null, query: QueryableCollection) {
    // Remove any search query
    // because we extract and handle it separately
    // Otherwise `convertRestQueryParams` will also handle it
    delete params._q;
    const filters: StrapiFilter = convertRestQueryParams(params);

    if (searchQuery) {
      query = buildSearchQuery(searchQuery, query);
    } else {
      (filters.where || []).forEach(({ field, operator, value }) => {

        // Coerce to the appropriate types
        // Because values from querystring will always come in as strings
        // Don't coerce the 'null' operatore because the value is true/false
        // not the type of the field
        if (operator !== 'null') {
          value = coerceValue(model, field, value);
        }

        query = query.where(field, operator, value);
      });
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
    const result = await (transaction ? transaction.get(query) : query.get());
    return result.docs;
  }




  async function find(params: any, populate?: string[]) {
    const populateOpt = populate || model.defaultPopulate;

    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);
      let docs: Snapshot[];
      if (model.hasPK(params)) {
        const ref = model.doc(model.getPK(params));
        const snap = await wrapper.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(params, null, wrapper);
      }

      return await populateDocs(model, docs, populateOpt, wrapper);
    });
  }

  async function findOne(params: any, populate?: string[]) {
    const entries = await find({ ...params, _limit: 1 }, populate);
    return entries[0] || null;
  }

  async function count(params: any) {
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(params, null, undefined);
    return docs.length;
  }

  async function create(values: any) {

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

    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);
      
      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await updateRelations(model, {
          values: model.pickRelations(value),
          data: value,
          ref
        }, wrapper);
      }));
      
      // Update relations
      await updateRelations(model, {
        values: relations,
        data,
        ref
      }, wrapper);
      
      // Populate relations
      const [entry] = await populateDocs(model, [{ ref, data: () => data }], model.defaultPopulate, wrapper);

      await model.create(ref, data, wrapper);
      wrapper.doWrites();

      return entry;
    });
  }

  async function update(params: any, values: any) {

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
    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);

      let ref: Reference;
      if (model.hasPK(params)) {
        ref = model.doc(model.getPK(params));
      } else {
        const docs = await runFirestoreQuery({ ...params, _limit: 1 }, null, wrapper);
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
        }, wrapper);
      }));

      // Update relations
      await updateRelations(model, {
        values: relations,
        data,
        ref
      }, wrapper);

      // Populate relations
      const [entry] = await populateDocs(model, [{ ref, data: () => data }], model.defaultPopulate, wrapper);

      // Update entry without relational data.
      await model.update(ref, data, wrapper);
      wrapper.doWrites();

      return entry;

    });
  }

  async function deleteMany(params: any) {
    if (model.hasPK(params)) {
      return await deleteOne(model.getPK(params))
    } else {
      // TODO: FIXME: Running multiple deletes at the same time
      // Deletes may affect many relations
      // All are transacted so they all may interfere with eachother
      // Should run in the same transaction
      const entries = await find(params);
      return Promise.all(entries.map(entry => deleteOne(entry[model.primaryKey])));
    }
  }

  async function deleteOne(id: string) {
    
    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);

      const ref = model.doc(id);
      const snap = await wrapper.get(ref);
      const entry = snap.data();
      if (!entry) {
        throw new StatusError('entry.notFound', 404);
      }

      const [doc] = await populateDocs(model, [snap], model.defaultPopulate, wrapper);

      await deleteRelations(model, { entry: doc, ref }, wrapper);

      await model.delete(ref, wrapper);
      wrapper.doWrites();

      return doc;
    });
  }

  async function search(params: any, populate?: string[]) {
    const populateOpt = populate || model.defaultPopulate;

    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);
      let docs: Snapshot[];
      if (model.hasPK(params)) {
        const ref = model.doc(model.getPK(params));
        const snap = await wrapper.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(params, params._q, wrapper);
      }

      return await populateDocs(model, docs, populateOpt, wrapper);
    });
  }

  async function countSearch(params: any) {
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(params, params._q, undefined);
    return docs.length;
  }

  return {
    findOne,
    find,
    create,
    update,
    delete: deleteMany,
    count,
    search,
    countSearch,
  };
};
