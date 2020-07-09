/**
 * Implementation of model queries for mongo
 */

import * as _ from 'lodash';
import { populateDocs } from './populate';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { convertRestQueryParams } from 'strapi-utils';
import type { StrapiQueryParams, StrapiFilter } from './types';
import { StatusError } from './utils/status-error';
import { deleteRelations, updateRelations } from './relations';
import { FieldValue, FieldPath } from '@google-cloud/firestore';
import { validateComponents } from './utils/validate-components';
import { TransactionWrapper } from './utils/transaction-wrapper';
import type { Snapshot, QueryableCollection } from './utils/queryable-collection';



export function queries({ model, modelKey, strapi }: StrapiQueryParams) {
  

  function buildSearchQuery(value: any, query: QueryableCollection) {
  
    Object.keys(model.attributes).forEach((field) => {
      switch (model.attributes[field].type) {
        case 'biginteger':
        case 'integer':
        case 'float':
        case 'decimal':
          const number = _.toNumber(value);
          if (!_.isNaN(number)) {
            query = query.where(field, 'eq', number, 'or');
          }
        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          query = query.where(field, new RegExp(value, 'i'), 'or');
      }
    });
  
    return query;
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

        // Convert reference ID to document reference
        const details = model.attributes[field];
        const assocModel = getModel(details.model || details.collection, details.plugin);
        if (assocModel) {
          value = getDocRef(value, assocModel);
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
      const [createdAtKey, updatedAtKey] = model.options.timestamps;
      data[createdAtKey] = FieldValue.serverTimestamp();
      data[updatedAtKey] = FieldValue.serverTimestamp();
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

      model.create(ref, data, wrapper);
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
      const [createdAtKey, updatedAtKey] = model.options.timestamps;

      // Prevent creation timestamp from being overwritten
      delete data[createdAtKey];

      data[updatedAtKey] = FieldValue.serverTimestamp();
    }

    // Run the transaction
    return await model.firestore.runTransaction(async trans => {
      const wrapper = new TransactionWrapper(trans, model.firestore);

      let snap: Snapshot | null;
      if (model.hasPK(params)) {
        const ref = model.doc(model.getPK(params));
        snap = await wrapper.get(ref);
        if (!snap.exists) {
          snap = null;
        }
      } else {
        const docs = await runFirestoreQuery({ ...params, _limit: 1 }, null, wrapper);
        snap = docs[0] || null;
      }

      if (!snap) {
        throw new StatusError('entry.notFound', 404);
      }


      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await updateRelations(model, {
          values: model.pickRelations(value),
          data: value,
          ref: snap!.ref
        }, wrapper);
      }));

      // Update relations
      await updateRelations(model, {
        values: relations,
        data,
        ref: snap.ref
      }, wrapper);

      // Populate relations
      const [entry] = await populateDocs(model, [snap], model.defaultPopulate, wrapper);

      // Update entry without relational data.
      model.setMerge(snap.ref, data, wrapper);
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

      model.delete(ref, wrapper);
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

