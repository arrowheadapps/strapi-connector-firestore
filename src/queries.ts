import * as _ from 'lodash';
import { PickReferenceKeys, populateDoc, populateSnapshots } from './populate';
import { StatusError } from './utils/status-error';
import type { StrapiQuery, StrapiContext, TransactionSuccessHook } from './types';
import type { Queryable } from './db/collection';
import type { Transaction } from './db/transaction';
import type { Reference, Snapshot } from './db/reference';
import { buildQuery, QueryArgs } from './build-query';


/**
 * Firestore connector implementation of the Strapi query interface.
 */
export interface FirestoreConnectorQueries<T extends object> extends StrapiQuery<T> {

}


export function queries<T extends object>({ model, strapi }: StrapiContext<T>): FirestoreConnectorQueries<T> {

  const log = model.options.logQueries
    ? (name: string, details: object) => { strapi.log.debug(`QUERY ${name}[${model.uid}] ${JSON.stringify(details)}`) }
    : () => {};

  const find: FirestoreConnectorQueries<T>['find'] = async (params, populate = (model.defaultPopulate as any)) => {
    log('find', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await buildAndFetchQuery({ model, params }, trans);
      
      // Populate relations
      return await populateSnapshots(snaps, populate, trans);
    }, { readOnly: true });
  };

  const findOne: FirestoreConnectorQueries<T>['findOne'] = async (params, populate) => {
    const [entry] = await find({ ...params, _limit: 1 }, populate);
    return entry || null;
  };

  const count: FirestoreConnectorQueries<T>['count'] = async (params) => {
    log('count', { params });
    return await model.runTransaction(async trans => {
      return await buildAndCountQuery({ model, params }, trans);
    }, { readOnly: true });
  };

  const create: FirestoreConnectorQueries<T>['create'] = async (values, populate = (model.defaultPopulate as any)) => {
    log('create', { populate });

    const ref = model.hasPK(values)
      ? model.db.doc(model.getPK(values))
      : model.db.doc();

    const { result, onSuccess } = await model.runTransaction(async trans => {
      // Create while coercing data and updating relations
      const data = await trans.create(ref, values);
      const onSuccess = await model.options.onChange(undefined, data, trans);
      
      // Populate relations
      const result = await populateDoc(model, ref, data, populate, trans);
      return { result, onSuccess };
    });

    // Run the success hook
    await runOnSuccess(onSuccess, result as any);
    return result;
  };

  const update: FirestoreConnectorQueries<T>['update'] = async (params, values, populate = (model.defaultPopulate as any)) => {
    log('update', { params, populate });
    
    const { result, onSuccess } =  await model.runTransaction(async trans => {
      const [snap] = await buildAndFetchQuery({
        model,
        params: { ...params, _limit: 1 },
      }, trans);

      const prevData = snap && snap.data();
      if (!prevData) {
        throw new StatusError('entry.notFound', 404);
      }

      // Update and merge coerced data (shallow merge)
      const data = {
        ...snap.data(),
        ...await trans.update(snap.ref, values),
      };
      const onSuccess = await model.options.onChange(prevData, data, trans);

      // Populate relations
      const result = await populateDoc(model, snap.ref, data, populate, trans);
      return { result, onSuccess };
    });

    // Run the success hook
    await runOnSuccess(onSuccess, result as any);
    return result;
  };

  const deleteMany: FirestoreConnectorQueries<T>['delete'] = async (params, populate = (model.defaultPopulate as any)) => {
    log('delete', { params, populate });

    const results = await model.runTransaction(async trans => {
      const query = buildQuery(model.db, { model, params });
      const snaps = await fetchQuery(query, trans);

      // The defined behaviour is unusual
      // Official connectors return a single item if queried by primary key or an array otherwise
      if (Array.isArray(query) && (query.length === 1)) {
        return await deleteOne(snaps[0], populate, trans);
      } else {
        return await Promise.all(
          snaps.map(snap => deleteOne(snap, populate, trans))
        );
      }
    });

    // Run the success hook
    if (Array.isArray(results)) {
      await Promise.all(results.map(r => r && runOnSuccess(r.onSuccess, r.result as any)));
    } else {
      if (results) {
        await runOnSuccess(results.onSuccess, results.result as any);
      }
    }

    // Return the results
    if (Array.isArray(results)) {
      return results.map(r => r && r.result);
    } else {
      return results && results.result;
    }
  };

  async function deleteOne<K extends PickReferenceKeys<T>>(snap: Snapshot<T>, populate: K[], trans: Transaction) {
    const prevData = snap.data();
    if (!prevData) {
      // Delete API returns `null` rather than throwing an error for non-existent documents
      return null;
    }

    // Delete while updating relations
    await trans.delete(snap.ref);
    const onSuccess = await model.options.onChange(prevData, undefined, trans);

    // Populate relations
    const result = await populateDoc(model, snap.ref, prevData, populate, trans);
    return { result, onSuccess };
  };

  const search: FirestoreConnectorQueries<T>['search'] = async (params, populate = (model.defaultPopulate as any)) => {
    log('search', { params, populate });

    return await model.runTransaction(async trans => {
      const snaps = await buildAndFetchQuery({ model, params, allowSearch: true }, trans);
      return await populateSnapshots(snaps, populate, trans);
    }, { readOnly: true });
  };

  const countSearch: FirestoreConnectorQueries<T>['countSearch'] = async (params) => {
    log('countSearch', { params });
    return await model.runTransaction(async trans => {
      return await buildAndCountQuery({ model, params, allowSearch: true });
    }, { readOnly: true });
  };

  const fetchRelationCounters: FirestoreConnectorQueries<T>['fetchRelationCounters'] = async (attribute, entitiesIds = []) => {
    log('fetchRelationCounters', { attribute, entitiesIds });

    const relation = model.relations.find(a => a.alias === attribute);
    if (!relation) {
      throw new StatusError(`Could not find relation "${attribute}" in model "${model.globalId}".`, 400);
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
    }, { readOnly: true });
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

async function buildAndCountQuery<T extends object>(args: QueryArgs<T>, transaction?: Transaction): Promise<number> {
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

async function buildAndFetchQuery<T extends object>(args: QueryArgs<T>, transaction: Transaction): Promise<Snapshot<T>[]> {
  const queryOrRefs = buildQuery(args.model.db, args);
  return await fetchQuery(queryOrRefs, transaction);
}

async function fetchQuery<T extends object>(queryOrRefs: Queryable<T> | Reference<T>[], transaction: Transaction): Promise<Snapshot<T>[]> {
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

async function runOnSuccess<T extends object>(onSuccess: void | TransactionSuccessHook<T>, result: T | undefined) {
  if (typeof onSuccess === 'function') {
    try {
      await onSuccess(result);
    } catch (err) {
      strapi.log.warn(`Transaction onSuccess hook threw an error: ${(err as any).message}`, err);
    }
  }
}
