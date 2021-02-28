import * as _ from 'lodash';
import { populateDoc, populateSnapshots } from './populate';
import type { QueryBuilder, AttributeKey, Strapi, ModelData, Model } from 'strapi';
import type { Queryable } from './db/queryable-collection';
import type { Transaction } from './db/transaction';
import type { Reference, Snapshot } from './db/reference';
import { buildQuery, QueryArgs } from './build-query';


export interface QueryBuilderArgs<T extends ModelData = ModelData> {
  strapi: Strapi
  modelKey: string
  model: Model<T>
}

export function queries<T extends ModelData>({ model, strapi }: QueryBuilderArgs<T>): QueryBuilder<T> {

  const log = model.options.logQueries
    ? (name: string, details: object) => { strapi.log.debug(`QUERY ${model.modelName}.${name}: ${JSON.stringify(details)}`) }
    : () => {};

  const find = async (params: any, populate = model.defaultPopulate) => {
    log('find', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await buildAndFetchQuery({ model, params }, trans);
      
      // Populate relations
      return await populateSnapshots(snaps, populate, trans);
    });
  };

  const findOne = async (params: any, populate = model.defaultPopulate) => {
    const [entry] = await find({ ...params, _limit: 1 }, populate);
    return entry || null;
  };

  const count = async (params: any) => {
    log('count', { params });
    return await buildAndCountQuery({ model, params });
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
      const [snap] = await buildAndFetchQuery({
        model,
        params: { ...params, _limit: 1 },
      }, trans);

      const prevData = snap && snap.data();
      if (!prevData) {
        throw strapi.errors.notFound();
      }

      // Update while coercing data and updating relations
      const data = await trans.update(snap.ref, values);

      // Populate relations
      const result = await populateDoc(model, snap.ref, data, populate, trans);
      
      // Merge previous and new data (shallow merge)
      return {
        ...snap.data(),
        ...result,
      };
    });
  };

  const deleteMany = async (params: any, populate = model.defaultPopulate) => {
    log('delete', { params, populate });

    return await model.runTransaction(async trans => {
      const query = buildQuery(model.db, { model, params });
      const snaps = await fetchQuery(query, trans);

      // The defined behaviour is unusual
      // Official connectors return a single item if queried by primary key or an array otherwise
      if (Array.isArray(query) && (query.length === 1)) {
        return await deleteOne(snaps[0], populate, trans);
      } else {
        return Promise.all(
          snaps.map(snap => deleteOne(snap, populate, trans))
        );
      }
    });
  };

  const deleteOne = async (snap: Snapshot<T>, populate: AttributeKey<T>[], trans: Transaction) => {
    const prevData = snap.data();
    if (!prevData) {
      // Delete API returns `null` rather than throwing an error for non-existent documents
      return null;
    }

    // Delete while updating relations
    await trans.delete(snap.ref);

    // Populate relations
    return await populateDoc(model, snap.ref, prevData, populate, trans);
  };

  const search = async (params: any, populate = model.defaultPopulate) => {
    log('search', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await buildAndFetchQuery({ model, params, allowSearch: true }, trans);
      return await populateSnapshots(snaps, populate, trans);
    });
  };

  const countSearch = async (params: any) => {
    log('countSearch', { params });
    return await buildAndCountQuery({ model, params, allowSearch: true });
  };

  const fetchRelationCounters = async (attribute: AttributeKey<T>, entitiesIds: string[] = []) => {
    log('fetchRelationCounters', { attribute, entitiesIds });

    const relation = model.relations.find(a => a.alias === attribute);
    if (!relation) {
      throw strapi.errors.badRequest(`Could not find relation "${attribute}" in model "${model.globalId}"`);
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

  const queries: QueryBuilder<T> = {
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

async function buildAndCountQuery<T extends ModelData>(args: QueryArgs<T>, transaction?: Transaction): Promise<number> {
  const queryOrIds = buildQuery(args.model.db, args);
  if (!queryOrIds) {
    return 0;
  }
  
  if (Array.isArray(queryOrIds)) {
    // Don't do any read operations if we already know the count
    return queryOrIds.length;
  } else {
    const result = transaction
      ? await transaction.getNonAtomic(queryOrIds)
      : await queryOrIds.get();
    return result.docs.length;
  }
}

async function buildAndFetchQuery<T extends ModelData>(args: QueryArgs<T>, transaction: Transaction): Promise<Snapshot<T>[]> {
  const queryOrRefs = buildQuery(args.model.db, args);
  return await fetchQuery(queryOrRefs, transaction);
}

async function fetchQuery<T extends ModelData>(queryOrRefs: Queryable<T> | Reference<T>[], transaction: Transaction): Promise<Snapshot<T>[]> {
  if (Array.isArray(queryOrRefs)) {
    if (queryOrRefs.length) {
      return await transaction.getNonAtomic(queryOrRefs, { isSingleRequest: true });
    } else {
      return [];
    }
  } else {
    const result = await transaction.getNonAtomic(queryOrRefs);
    return result.docs;
  }
}
