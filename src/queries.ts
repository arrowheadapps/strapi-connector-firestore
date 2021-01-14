import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { populateDoc, populateDocs } from './populate';
import { relationsDelete, relationsUpdate } from './relations';
import { buildPrefixQuery } from './utils/prefix-query';
import { StatusError } from './utils/status-error';
import { validateComponents } from './utils/components';
import type { FirestoreConnectorModel } from './model';
import type { StrapiQuery, StrapiAttributeType, StrapiFilter, AttributeKey, StrapiContext, StrapiWhereFilter } from './types';
import type { Queryable, Reference, Snapshot } from './utils/queryable-collection';
import type { Transaction } from './utils/transaction';
import { updateComponentsMetadata } from './utils/components-indexing';


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
      let docs: Snapshot<T>[];
      if (model.hasPK(params)) {
        const ref = model.db.doc(model.getPK(params));
        const snap = await trans.getNonAtomic(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(model, params, null, trans);
      }

      return await populateDocs(model, docs, populate, trans);
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

    // Validate components dynamiczone
    const components = validateComponents(model, values);
    updateComponentsMetadata(model, values);

    // Add timestamp data
    if (model.timestamps) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = model.timestamps;
      values[createdAtKey] = now;
      values[updatedAtKey] = now;
    }

    // Create entry without relational data
    const id = model.getPK(values);
    const ref = id ? model.db.doc(id) : model.db.doc();
    values[model.primaryKey] = ref.id;

    return await model.runTransaction(async trans => {
      
      // Update components
      await Promise.all(components.map(async ({ model, value }) => {
        await relationsUpdate(model, ref, undefined, value, trans);
      }));
      
      // Update relations
      await relationsUpdate(model, ref, undefined, values, trans);
      
      // Populate relations
      const entry = await populateDoc(model, { ref, data: () => values }, populate, trans);

      trans.create(ref, values);
      return entry;
    });
  };

  const update = async (params: any, values: any, populate = model.defaultPopulate) => {
    log('update', { params, populate });

    // Validate components dynamiczone
    const components = validateComponents(model, values);
    updateComponentsMetadata(model, values);

    // Add timestamp data
    if (model.timestamps) {
      const now = new Date();
      const [createdAtKey, updatedAtKey] = model.timestamps;

      // Prevent creation timestamp from being overwritten
      delete values[createdAtKey];
      values[updatedAtKey] = now;
    }

    // Run the transaction
    return await model.runTransaction(async trans => {

      let snap: Snapshot<T>;
      if (model.hasPK(params)) {
        snap = await trans.getAtomic(model.db.doc(model.getPK(params)));
      } else {
        const docs = await runFirestoreQuery(model, { ...params, _limit: 1 }, null, trans);
        snap = docs[0];
      }

      const prevData = snap.data();
      if (!prevData) {
        throw new StatusError('entry.notFound', 404);
      }


      // Update components
      await Promise.all(components.map(async ({ model, key, value }) => {
        const prevValue = _.castArray(_.get(prevData, key) || []).find(c => model.getPK(c) === model.getPK(value));
        await relationsUpdate(model, snap.ref, prevValue, value, trans);
      }));

      // Update relations
      await relationsUpdate(model, snap.ref, prevData, values, trans);

      // Populate relations
      const entry = await populateDoc(model, { ref: snap.ref, data: () => values }, populate, trans);

      // Write the entry
      trans.update(snap.ref, values);
      return entry;
    });
  };

  const deleteMany = async (params: any, populate = model.defaultPopulate) => {
    log('delete', { params, populate });

    return await model.runTransaction(async trans => {
      if (model.hasPK(params)) {
        const ref = model.db.doc(model.getPK(params));
        const result = await deleteOne(await trans.getNonAtomic(ref), populate, trans);
        return [result];
      } else {
        const snaps = await runFirestoreQuery(model, params, null, trans);
        return Promise.all(snaps.map(snap => deleteOne(snap, populate, trans)));
      }
    });
  };

  const deleteOne = async (snap: Snapshot<T>, populate: AttributeKey<T>[], trans: Transaction) => {
    const data = snap.data();
    if (!data) {
      throw new StatusError('entry.notFound', 404);
    }

    const doc = await populateDoc(model, snap, populate, trans);

    await relationsDelete(model, snap.ref, data, trans);

    trans.delete(snap.ref);
    return doc;
  };

  const search = async (params: any, populate = model.defaultPopulate) => {
    log('search', { params, populate });

    return await model.runTransaction(async trans => {
      let docs: Snapshot<T>[];
      if (model.hasPK(params)) {
        const ref = model.db.doc(model.getPK(params));
        const snap = await trans.getNonAtomic(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await runFirestoreQuery(model, params, params._q, trans);
      }

      return await populateDocs(model, docs, populate, trans);
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

    return await model.runTransaction(async transaction => {
      const snaps = await transaction.getNonAtomic(entitiesIds.map(id => model.db.doc(id)));

      return Promise.all(snaps.map(async snap => {
        const data = snap.data();
        const count = data ? (await relation.findRelated(snap.ref, data, transaction)).length : 0;
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
    // Check for special case where the only filter is id_in
    // In this case it is more effective to fetch the documents
    // by id, because the "in" operator only supports ten arguments
    if (where && (where.length === 1)
      && (where[0].field === model.primaryKey)
      && (where[0].operator === 'in')) {
      
      return _.castArray(where[0].value || [])
        .slice(start || 0, (limit || -1) < 1 ? undefined : limit)
        .map(value => {
          if (!value || (typeof value !== 'string')) {
            throw new StatusError(`Argument for "${model.primaryKey}_in" must be an array of strings`, 400);
          }
          return model.db.doc(value);
        });

    } else {
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
    return await transaction.getNonAtomic(queryOrIds);
  } else {
    const result = await transaction.getNonAtomic(queryOrIds);
    return result.docs
  }
}
