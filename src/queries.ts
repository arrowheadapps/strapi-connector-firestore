import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { populateDoc, populateDocs } from './populate';
import { relationsDelete, relationsUpdate } from './relations';
import { coerceAttribute, toFirestore } from './utils/coerce';
import { convertWhere, ManualFilter } from './utils/convert-where';
import { buildPrefixQuery } from './utils/prefix-query';
import { StatusError } from './utils/status-error';
import { updateComponentsMetadata, validateComponents } from './utils/components';
import type { FirestoreConnectorModel } from './model';
import type { StrapiQuery, StrapiAttributeType, StrapiFilter, AttributeKey, StrapiContext } from './types';
import type { Queryable, Snapshot } from './utils/queryable-collection';
import type { Transaction } from './utils/transaction';


/**
 * Firestore connector implementation of the Strapi query interface.
 */
export interface FirestoreConnectorQueries<T extends object> extends StrapiQuery<T> {

}


export function queries<T extends object>({ model }: StrapiContext<T>): FirestoreConnectorQueries<T> {

  const find = async (params: any, populate = model.defaultPopulate) => {
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
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(model, params, null, null);
    return docs.length;
  };

  const create = async (values: any, populate = model.defaultPopulate) => {

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
    // Don't populate any fields, we are just counting
    const docs = await runFirestoreQuery(model, params, params._q, null);
    return docs.length;
  };

  const fetchRelationCounters = async (attribute: AttributeKey<T>, entitiesIds: string[] = []) => {

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

function buildFirestoreQuery<T extends object>(model: FirestoreConnectorModel<T>, params, searchQuery: string | null, query: Queryable<T>): Queryable<T> | null {
  // Remove any search query
  // because we extract and handle it separately
  // Otherwise `convertRestQueryParams` will also handle it
  delete params._q;
  const filters: StrapiFilter = convertRestQueryParams(params);

  if (searchQuery) {
    query = buildSearchQuery(model, searchQuery, query);
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
        value = Array.isArray(value)
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
    if (field === model.primaryKey) {
      if (searchQuery || 
        (filters.where || []).some(w => w.field !== model.primaryKey)) {
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

async function runFirestoreQuery<T extends object>(model: FirestoreConnectorModel<T>, params, searchQuery: string | null, transaction: Transaction | null) {
  const query = buildFirestoreQuery(model, params, searchQuery, model.db);
  if (!query) {
    return [];
  }

  const result = await (transaction ? transaction.getNonAtomic(query) : query.get());
  return result.docs;
}
