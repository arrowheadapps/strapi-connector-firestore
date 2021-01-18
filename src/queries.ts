import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { populateDoc, populateSnapshots } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import { StatusError } from './utils/status-error';
import type { FirestoreConnectorModel } from './model';
import type { StrapiQuery, StrapiAttributeType, StrapiFilter, AttributeKey, StrapiContext, StrapiWhereFilter } from './types';
import type { Queryable } from './db/queryable-collection';
import type { Transaction } from './db/transaction';
import type { Reference, Snapshot } from './db/reference';


/**
 * Firestore connector implementation of the Strapi query interface.
 */
export interface FirestoreConnectorQueries<T extends object> extends StrapiQuery<T> {

}


export function queries<T extends object>({ model, strapi }: StrapiContext<T>): FirestoreConnectorQueries<T> {

  const log = model.options.logQueries
    ? (name: string, details: object) => { strapi.log.debug(`QUERY ${model.modelName}.${name}: ${JSON.stringify(details)}`) }
    : () => {};

  const find = async (params: any, populate = model.defaultPopulate) => {
    log('find', { params, populate });

    return await model.runTransaction(async trans => {
      let snaps: Snapshot<T>[];
      if (model.hasPK(params)) {
        const ref = model.db.doc(model.getPK(params));
        const snap = await trans.getNonAtomic(ref, { isSingleRequest: true });
        if (!snap.exists) {
          snaps = [];
        } else {
          snaps = [snap];
        }
      } else {
        snaps = await runFirestoreQuery(model, params, null, trans);
      }

      return await populateSnapshots(snaps, populate, trans);
    });
  };

  const findOne = async (params: any, populate = model.defaultPopulate) => {
    const entries = await find({ ...params, _limit: 1 }, populate);
    return entries[0] || null;
  };

  const count = async (params: any) => {
    log('count', { params });

    return await model.runTransaction(async trans => {
      // Don't populate any fields, we are just counting
      const docs = await runFirestoreQuery(model, params, null, trans);
      return docs.length;
    });
  };

  const create = async (values: any, populate = model.defaultPopulate) => {
    log('create', { populate });

    const ref = model.hasPK(values)
      ? model.db.doc(model.getPK(values))
      : model.db.doc();

    return await model.runTransaction(async trans => {
      // Create while coercing data and updating relations
      const data = await trans.create(ref, values);
      
      // Populate relations
      return await populateDoc(model, ref, data, populate, trans);
    });
  };

  const update = async (params: any, values: any, populate = model.defaultPopulate) => {
    log('update', { params, populate });
    
    return await model.runTransaction(async trans => {
      const [snap] = await runFirestoreQuery(model, { ...params, _limit: 1 }, null, trans);

      const prevData = snap && snap.data();
      if (!prevData) {
        throw new StatusError('entry.notFound', 404);
      }

      // Update while coercing data and updating relations
      const data = await trans.update(snap.ref, values);

      // Populate relations
      return {
        ...snap.data(),
        ...await populateDoc(model, snap.ref, data, populate, trans),
      };
    });
  };

  const deleteMany = async (params: any, populate = model.defaultPopulate) => {
    log('delete', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await runFirestoreQuery(model, params, null, trans);
      return Promise.all(
        snaps.map(snap => deleteOne(snap, populate, trans))
      );
    });
  };

  const deleteOne = async (snap: Snapshot<T>, populate: AttributeKey<T>[], trans: Transaction) => {
    const prevData = snap.data();
    if (!prevData) {
      throw new StatusError('entry.notFound', 404);
    }

    // Delete while updating relations
    await trans.delete(snap.ref);

    // Populate relations
    return await populateDoc(model, snap.ref, prevData, populate, trans);
  };

  const search = async (params: any, populate = model.defaultPopulate) => {
    log('search', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await runFirestoreQuery(model, params, params._q, trans);
      return await populateSnapshots(snaps, populate, trans);
    });
  };

  const countSearch = async (params: any) => {
    log('countSearch', { params });

    return await model.runTransaction(async trans => {
      // Don't populate any fields, we are just counting
      const docs = await runFirestoreQuery(model, params, params._q, trans);
      return docs.length;
    });
  };

  const fetchRelationCounters = async (attribute: AttributeKey<T>, entitiesIds: string[] = []) => {
    log('fetchRelationCounters', { attribute, entitiesIds });

    const relation = model.relations.find(a => a.alias === attribute);
    if (!relation) {
      throw new Error(`Could not find relation "${attribute}" in model "${model.globalId}".`);
    }

    if (!entitiesIds.length) {
      return [];
    }

    return await model.runTransaction(async trans => {
      const snaps = await trans.getNonAtomic(entitiesIds.map(id => model.db.doc(id)));

      return Promise.all(snaps.map(async snap => {
        const data = snap.data();
        const count = data ? (await relation.findRelated(snap.ref, data, trans)).length : 0;
        return {
          id: snap.id,
          count,
        };
      }));
    });
  };

  const queries: FirestoreConnectorQueries<T> = {
    model,
    find,
    findOne,
    count,
    create,
    update,
    delete: deleteMany,
    search,
    countSearch,
    fetchRelationCounters,
  };
  return queries;
}


  

function buildSearchQuery<T extends object>(model: FirestoreConnectorModel<T>, value: any, query: Queryable<T>) {

  if (model.options.searchAttribute) {
    const field = model.options.searchAttribute;
    const type: StrapiAttributeType | undefined = (field === model.primaryKey)
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
        return query.where(field, 'eq', value);

      case 'string':
      case 'text':
      case 'richtext':
      case 'email':
      case 'enumeration':
      case 'uid':
        // Use prefix operator
        const { gte, lt } = buildPrefixQuery(value);
        return query
          .where(field, 'gte', gte)
          .where(field, 'lt', lt);

      case 'password':
        // Explicitly don't search in password fields
        throw new Error('Not allowed to query password fields');
        
      default:
        throw new Error(`Search attribute "${field}" is an of an unsupported type`);
    }

  } else {

    // Build a manual implementation of fully-featured search
    const filters: StrapiWhereFilter[] = [];

    if (value != null) {
      filters.push({ field: model.primaryKey, operator: 'containss', value });
    }

    for (const field of Object.keys(model.attributes)) {
      const attr = model.attributes[field];
      switch (attr.type) {
        case 'integer':
        case 'float':
        case 'decimal':
        case 'biginteger':
          try {
            // Use equality operator for numbers
            filters.push({ field, operator: 'eq', value });
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
            filters.push({ field, operator: 'contains', value });
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
    }

    return query.whereAny(filters);
  }
};

function buildFirestoreQuery<T extends object>(model: FirestoreConnectorModel<T>, params, searchQuery: string | null, query: Queryable<T>): Queryable<T> | Reference<T>[] | null {
  // Remove any search query
  // because we extract and handle it separately
  // Otherwise `convertRestQueryParams` will also handle it
  delete params._q;
  const { where, limit, sort, start }: StrapiFilter = convertRestQueryParams(params);

  if (searchQuery) {
    query = buildSearchQuery(model, searchQuery, query);
  } else {
    // Check for special case where querying for document IDs
    // In this case it is more effective to fetch the documents by id
    // because the "in" operator only supports ten arguments
    if (where && (where.length === 1)) {
      const [{ field, operator, value }] = where;
      if (field === model.primaryKey) {
        if (!value || (typeof value !== 'string')) {
          throw new StatusError(`Argument for "${model.primaryKey}" must be an array of strings`, 400);
        }

        if ((operator === 'eq') || (operator === 'in')) {
          return _.castArray(value || [])
            .slice(start || 0, (limit || -1) < 1 ? undefined : limit)
            .map(v =>  model.db.doc(v));
        }
      }
    }

    // Otherwise continue building normal query
    for (let { field, operator, value } of (where || [])) {
      if (operator === 'in') {
        if (Array.isArray(value) && (value.length === 0)) {
          // Special case: empty query
          return null;
        }
        value = _.castArray(value);
      }
      if (operator === 'nin') {
        if (Array.isArray(value) && (value.length === 0)) {
          // Special case: no effect
          continue;
        }
        value = _.castArray(value);
      }

      // Prevent querying passwords
      if (model.attributes[field]?.type === 'password') {
        throw new Error('Not allowed to query password fields');
      }

      query = query.where(field, operator, value);
    }
  }

  for (const { field, order } of (sort || [])) {
    if (field === model.primaryKey) {
      if (searchQuery || 
        (where || []).some(w => w.field !== model.primaryKey)) {
        // Ignore sort by document ID when there are other filers
        // on fields other than the document ID
        // Document ID is the default sort for all queries 
        // And more often than not, it interferes with Firestore inequality filter
        // or indexing rules
      } else {
        query = query.orderBy(FieldPath.documentId() as any, order);
      }
    } else {
      query = query.orderBy(field, order);
    }
  };

  if (start && (start > 0)) {
    query = query.offset(start);
  }

  if (limit && (limit > 1)) {
    query = query.limit(limit);
  }

  return query;
}

async function runFirestoreQuery<T extends object>(model: FirestoreConnectorModel<T>, params, searchQuery: string | null, transaction: Transaction): Promise<Snapshot<T>[]> {
  const queryOrIds = buildFirestoreQuery(model, params, searchQuery, model.db);
  if (!queryOrIds) {
    return [];
  }
  if (Array.isArray(queryOrIds)) {
    return await transaction.getNonAtomic(queryOrIds, { isSingleRequest: true });
  } else {
    const result = await transaction.getNonAtomic(queryOrIds);
    return result.docs;
  }
}
