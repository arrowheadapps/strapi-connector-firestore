'use strict';
/**
 * Implementation of model queries for mongo
 */

const _ = require('lodash');
const populateDocs = require('./populate');
const { getDocRef, getModel } = require('./get-doc-ref');
const { convertRestQueryParams, buildQuery, models: modelUtils } = require('strapi-utils');

const { findComponentByGlobalId } = require('./utils/helpers');

const hasPK = (obj, model) => _.has(obj, model.primaryKey) || _.has(obj, 'id');
const getPK = (obj, model) => (_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id);

/**
 * 
 * @param {Object} options - Query options
 * @param {FirebaseFirestore.CollectionReference} options.model - The model you are querying
 */
module.exports = ({ model, modelKey, strapi }) => {
  const assocKeys = model.associations.map(ast => ast.alias);
  const componentKeys = Object.keys(model.attributes).filter(key =>
    ['component', 'dynamiczone'].includes(model.attributes[key].type)
  );
  const metaKeys = ['_id', 'id', '_createTime', '_updateTime']

  const excludedKeys = assocKeys.concat(componentKeys).concat(metaKeys);

  const defaultPopulate = model.associations
    .filter(ast => ast.autoPopulate !== false)
    .map(ast => ast.alias);

  const pickRelations = values => {
    return _.pick(values, assocKeys);
  };

  const omitExernalValues = values => {
    return _.omit(values, excludedKeys);
  };

  /**
   * 
   * @param {FirebaseFirestore.DocumentReference} docRef 
   * @param {*} values 
   */
  async function createComponents(data, values) {
    if (componentKeys.length === 0) return;

    for (let key of componentKeys) {
      const attr = model.attributes[key];
      const { type } = attr;

      if (type === 'component') {
        const { component, required = false, repeatable = false } = attr;

        const componentModel = strapi.components[component];

        if (required === true && !_.has(values, key)) {
          const err = new Error(`Component ${key} is required`);
          err.status = 400;
          throw err;
        }

        if (!_.has(values, key)) continue;

        const componentValue = values[key];

        if (repeatable === true) {
          validateRepeatableInput(componentValue, { key, ...attr });
          const components = await Promise.all(
            componentValue.map(value => {
              return strapi.query(component).create(value);
            })
          );

          const componentsArr = components.map(componentEntry => ({
            kind: componentModel.globalId,
            ref: componentEntry.id,
          }));

          data[key] = componentsArr;
          // await docRef.save();
        } else {
          validateNonRepeatableInput(componentValue, { key, ...attr });
          if (componentValue === null) continue;

          const componentEntry = await strapi.query(component).create(componentValue);
          data[key] = [
            {
              kind: componentModel.globalId,
              ref: componentEntry.id,
            },
          ];
          // await docRef.save();
        }
      }

      if (type === 'dynamiczone') {
        const { required = false } = attr;

        if (required === true && !_.has(values, key)) {
          const err = new Error(`Dynamiczone ${key} is required`);
          err.status = 400;
          throw err;
        }

        if (!_.has(values, key)) continue;

        const dynamiczoneValues = values[key];

        validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });

        const dynamiczones = await Promise.all(
          dynamiczoneValues.map(value => {
            const component = value.__component;
            return strapi
              .query(component)
              .create(value)
              .then(entity => {
                return {
                  __component: value.__component,
                  entity,
                };
              });
          })
        );

        const componentsArr = dynamiczones.map(({ __component, entity }) => {
          const componentModel = strapi.components[__component];

          return {
            kind: componentModel.globalId,
            ref: entity.id,
          };
        });

        data[key] = componentsArr;
        // await docRef.save();
      }
    }
  }

  /**
   * 
   * @param {FirebaseFirestore.DocumentData} data 
   * @param {*} values 
   */
  async function updateComponents(data, values) {
    if (componentKeys.length === 0) return;

    const updateOrCreateComponent = async ({ componentUID, value }) => {
      // check if value has an id then update else create
      const query = strapi.query(componentUID);
      if (hasPK(value, query.model)) {
        return query.update(
          {
            [query.model.primaryKey]: getPK(value, query.model),
          },
          value
        );
      }
      return query.create(value);
    };

    for (let key of componentKeys) {
      // if key isn't present then don't change the current component data
      if (!_.has(values, key)) continue;

      const attr = model.attributes[key];
      const { type } = attr;

      if (type === 'component') {
        const { component: componentUID, repeatable = false } = attr;

        const componentModel = strapi.components[componentUID];
        const componentValue = values[key];

        if (repeatable === true) {
          validateRepeatableInput(componentValue, { key, ...attr });

          await deleteOldComponents(data, componentValue, {
            key,
            componentModel,
          });

          const components = await Promise.all(
            componentValue.map(value => updateOrCreateComponent({ componentUID, value }))
          );
          const componentsArr = components.map(component => ({
            kind: componentModel.globalId,
            ref: component.id,
          }));

          data[key] = componentsArr;
          // await data.save();
        } else {
          validateNonRepeatableInput(componentValue, { key, ...attr });

          await deleteOldComponents(data, componentValue, {
            key,
            componentModel,
          });

          if (componentValue === null) continue;

          const component = await updateOrCreateComponent({
            componentUID,
            value: componentValue,
          });

          data[key] = [
            {
              kind: componentModel.globalId,
              ref: component.id,
            },
          ];
          // await data.save();
        }
      }

      if (type === 'dynamiczone') {
        const dynamiczoneValues = values[key];

        validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });

        await deleteDynamicZoneOldComponents(data, dynamiczoneValues, {
          key,
        });

        const dynamiczones = await Promise.all(
          dynamiczoneValues.map(value => {
            const componentUID = value.__component;
            return updateOrCreateComponent({ componentUID, value }).then(entity => {
              return {
                componentUID,
                entity,
              };
            });
          })
        );

        const componentsArr = dynamiczones.map(({ componentUID, entity }) => {
          const componentModel = strapi.components[componentUID];

          return {
            kind: componentModel.globalId,
            ref: entity.id,
          };
        });

        data[key] = componentsArr;
        // await data.save();
      }
    }
    return;
  }

  async function deleteDynamicZoneOldComponents(entry, values, { key }) {
    const idsToKeep = values.reduce((acc, value) => {
      const component = value.__component;
      const componentModel = strapi.components[component];
      if (hasPK(value, componentModel)) {
        acc.push({
          id: getPK(value, componentModel).toString(),
          componentUID: componentModel.uid,
        });
      }

      return acc;
    }, []);

    const allIds = []
      .concat(entry[key] || [])
      .filter(el => el.ref)
      .map(el => ({
        id: el.ref._id.toString(),
        componentUID: findComponentByGlobalId(el.kind).uid,
      }));

    // verify the provided ids are realted to this entity.
    idsToKeep.forEach(({ id, componentUID }) => {
      if (!allIds.find(el => el.id === id && el.componentUID === componentUID)) {
        const err = new Error(
          `Some of the provided components in ${key} are not related to the entity`
        );
        err.status = 400;
        throw err;
      }
    });

    const idsToDelete = allIds.reduce((acc, { id, componentUID }) => {
      if (!idsToKeep.find(el => el.id === id && el.componentUID === componentUID)) {
        acc.push({
          id,
          componentUID,
        });
      }
      return acc;
    }, []);

    if (idsToDelete.length > 0) {
      const deleteMap = idsToDelete.reduce((map, { id, componentUID }) => {
        if (!_.has(map, componentUID)) {
          map[componentUID] = [id];
          return map;
        }

        map[componentUID].push(id);
        return map;
      }, {});

      await Promise.all(
        Object.keys(deleteMap).map(componentUID => {
          return strapi
            .query(componentUID)
            .delete({ [`${model.primaryKey}_in`]: deleteMap[componentUID] });
        })
      );
    }
  }

  async function deleteOldComponents(entry, componentValue, { key, componentModel }) {
    const componentArr = Array.isArray(componentValue) ? componentValue : [componentValue];

    const idsToKeep = componentArr
      .filter(val => hasPK(val, componentModel))
      .map(val => getPK(val, componentModel));

    const allIds = []
      .concat(entry[key] || [])
      .filter(el => el.ref)
      .map(el => el.ref._id);

    // verify the provided ids are related to this entity.
    idsToKeep.forEach(id => {
      if (allIds.findIndex(currentId => currentId.toString() === id.toString()) === -1) {
        const err = new Error(
          `Some of the provided components in ${key} are not related to the entity`
        );
        err.status = 400;
        throw err;
      }
    });

    const idsToDelete = allIds.reduce((acc, id) => {
      if (idsToKeep.includes(id.toString())) return acc;
      return acc.concat(id);
    }, []);

    if (idsToDelete.length > 0) {
      await strapi.query(componentModel.uid).delete({ [`${model.primaryKey}_in`]: idsToDelete });
    }
  }

  async function deleteComponents(entry) {
    if (componentKeys.length === 0) return;

    for (let key of componentKeys) {
      const attr = model.attributes[key];
      const { type } = attr;

      if (type === 'component') {
        const { component } = attr;
        const componentModel = strapi.components[component];

        if (Array.isArray(entry[key]) && entry[key].length > 0) {
          const idsToDelete = entry[key].map(el => el.ref);
          await strapi
            .query(componentModel.uid)
            .delete({ [`${model.primaryKey}_in`]: idsToDelete });
        }
      }

      if (type === 'dynamiczone') {
        if (Array.isArray(entry[key]) && entry[key].length > 0) {
          const idsToDelete = entry[key].map(el => ({
            componentUID: findComponentByGlobalId(el.kind).uid,
            id: el.ref,
          }));

          const deleteMap = idsToDelete.reduce((map, { id, componentUID }) => {
            if (!_.has(map, componentUID)) {
              map[componentUID] = [id];
              return map;
            }

            map[componentUID].push(id);
            return map;
          }, {});

          await Promise.all(
            Object.keys(deleteMap).map(componentUID => {
              return strapi.query(componentUID).delete({
                [`${model.primaryKey}_in`]: deleteMap[componentUID],
              });
            })
          );
        }
      }
    }
  }



  function manualWhere(field, predicate) {
    return (docData) => {
      const value = _.get(docData, field, undefined);
      return predicate(value);
    };
  }

  function convertWhere({ field, value, operator }) {
    
    const details = model._attributes[field];
    const assocModel = getModel(details.model || details.collection, details.plugin);

    if (assocModel) {
      // Convert reference ID to document reference
      value = getDocRef(value, assocModel);
    }

    let op;
    switch (operator) {
      case 'eq':
        op = '==';
        break;
      case 'ne':
        op = manualWhere(field, (val) => val != value);
        break;
      case 'in':
        op = 'in';
        break;
      case 'nin':
        op = manualWhere(field, (val) => !_.includes(val, value));
        break;
      case 'contains':
        op = manualWhere(field, (val) => _.includes(val, value));
        break;
      case 'ncontains':
        op = manualWhere(field, (val) => !_.includes(val, value));
        break;
      case 'containss':
        op = manualWhere(field, (val) => _.includes(_.toLower(val), _.toLower(value)));
        break;
      case 'ncontainss':
        op = manualWhere(field, (val) => !_.includes(_.toLower(val), _.toLower(value)));
        break;
      case 'lt':
        op = '<';
        break;
      case 'lte':
        op = '<=';
        break;
      case 'gt':
        op = '>';
        break;
      case 'gte':
        op = '>=';
        break;
      case 'null':
        if (value) {
          op = '==';
          value = null;
        } else {
          op = manualWhere(field, (val) => val != null);
        }
        break;
    }

    return {
      field,
      operator: op,
      value
    };
  }

  /**
   * 
   * @param {FirebaseFirestore.Transaction} transaction 
   */
  async function buildFirestoreQuery(params, transaction) {

    console.log(`QUERY ${model.id}: ${JSON.stringify(params)}`);

    /**
      {
        sort: [
          { field, order: 'asc' | 'desc'  }
        ]
        start: number,
        limit: number,
        where: [
          { field, value, operator }
        ]
      }

      Where `operator` is one of:
        'eq',
        'ne',
        'in',
        'nin',
        'contains',
        'ncontains',
        'containss',
        'ncontainss',
        'lt',
        'lte',
        'gt',
        'gte',
        'null',
     */
    const filters = convertRestQueryParams(params);

    /** @type {FirebaseFirestore.Query} */
    let query = model;
    const manualFilters = [];

    (filters.where || []).forEach((filter) => {
      const { field, operator, value } = convertWhere(filter);
      if (typeof operator === 'function') {
        manualFilters.push(operator);
      } else {
        query = query.where(field, operator, value);
      }
    });

    (filters.sort || []).forEach(({ field, order }) => {
      if (_.includes(metaKeys, field)) {
        // Can't support sorting by document ID (it is not part
        // of the document's fields)
        // Sort fields also act as a filter so this would elminiate all results

        // FIXME:
        // Because of this implementation, sorting on _updateTime and _createTime
        // is broken
        return;
      }
      query = query.orderBy(field, order);
    });

    if (filters.start && (filters.start > 0)) {
      query = query.offset(filters.start);
    }

    if (filters.limit && (filters.limit > 0)) {
      query = query.limit(filters.limit);
    }

    // Perform the query
    let docs = (await (transaction ? transaction.get(query) : query.get())).docs;


    // Perform manual filters
    // This can result in the fewer documents than indended being returned
    if (manualFilters.length) {
      docs = docs.filter((doc) => manualFilters.every(op => op(doc.data())));
    }

    console.log(`QUERY ${model.id}: ${JSON.stringify(params)} = ${docs.length}`);

    return docs;
  }




  async function find(params, populate) {
    const populateOpt = populate || defaultPopulate;

    return await model.firestore.runTransaction(async trans => {
      let docs;
      if (params[model.primaryKey]) {
        const ref = model.doc(params[model.primaryKey]);
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await buildFirestoreQuery({ ...params, _limit: 1 }, trans);
      }

      return await populateDocs(model, docs.map(snap => ({ snap })), populateOpt, trans);
    });
  }

  async function findOne(params, populate) {
    const entries = await find({ ...params, _limit: 1 }, populate);
    return entries[0] || null;
  }

  async function count(params) {
    // Don't populate any fields, we are just counting
    const docs = await buildFirestoreQuery(params);
    return docs.length;
  }

  async function create(values) {

    console.log(`CREATE ${model.id}: ${JSON.stringify(values)}`);

    // Extract values related to relational data.
    const relations = pickRelations(values);
    let data = omitExernalValues(values);

    // Create entry with no-relational data.
    const ref = model.doc();
    await createComponents(data, values);

    return await model.firestore.runTransaction(async trans => {
      

      // Create relational data and return the entry.
      const [entry] = await populateDocs(model, [{ snap: ref, data }], defaultPopulate, trans);
      data = await model.updateRelations({
        [model.primaryKey]: ref.id,
        values: relations,
        data,
        entry
      }, trans);

      trans.create(ref, data);
      // const entry = {
      //   ...data,
      //   [model.primaryKey]: ref.id,
      //   // FIXME: Get timestamp metadata somehow
      //   // _createTime: result.writeTime,
      //   // _updateTime: result.writeTime
      // };

      return entry;
    });


  }

  async function update(params, values) {
    // Extract values related to relational data.
    const relations = pickRelations(values);
    let data = omitExernalValues(values);

    // Run the transaction
    return await model.firestore.runTransaction(async trans => {
      /** @type {FirebaseFirestore.QueryDocumentSnapshot} */
      let snap;
      if (params[model.primaryKey]) {
        const ref = model.doc(params[model.primaryKey]);
        snap = await trans.get(ref);
        if (!snap.exists) {
          snap = null;
        }
      } else {
        const docs = await buildFirestoreQuery({ ...params, _limit: 1 }, trans);
        snap = docs[0] || null;
      }

      if (!snap) {
        const err = new Error('entry.notFound');
        err.status = 404;
        throw err;
      }


      // update components first in case it fails don't update the entity
      await updateComponents(data, values);


      // Update relational data
      const [entry] = await populateDocs(model, [{ snap, data }], defaultPopulate, trans);
      data = await model.updateRelations({
        [model.primaryKey]: snap.id,
        values: relations,
        data,
        entry
      }, trans);


      // Update entry with no-relational data.
      trans.set(snap.ref, data);

      return entry;

    });
  }

  async function deleteMany(params) {
    if (params[model.primaryKey]) {
      return await deleteOne(params[model.primaryKey]);
    } else {
      // FIXME: Running multiple deletes at the same time
      // Deletes may affect many relations
      // All are transacted so they all may interfere with eachother
      // Should run in the same transaction
      const entries = await find(params);
      return Promise.all(entries.map(entry => deleteOne(entry[model.primaryKey])));
    }
  }

  async function deleteOne(id) {
    
    return await model.firestore.runTransaction(async trans => {
      const ref = model.doc(id);
      const snap = await trans.get(ref);
      const entry = snap.data();
      if (!entry) {
        const err = new Error('entry.notFound');
        err.status = 404;
        throw err;
      }

      const docs = await populateDocs(model, [{ snap }], defaultPopulate, trans);

      await deleteComponents(entry, trans);
      await model.deleteRelations({ data: entry }, trans);

      trans.delete(ref);

      return docs[0];
    });
  }

  function search(params, populate) {
    throw new Error('notImplemented');

    // // Convert `params` object to filters compatible with Mongo.
    // const filters = modelUtils.convertParams(modelKey, params);

    // const $or = buildSearchOr(model, params._q);
    // if ($or.length === 0) return Promise.resolve([]);

    // return model
    //   .find({ $or })
    //   .sort(filters.sort)
    //   .skip(filters.start)
    //   .limit(filters.limit)
    //   .populate(populate || defaultPopulate)
    //   .then(results => results.map(result => (result ? result.toObject() : null)));
  }

  function countSearch(params) {
    throw new Error('notImplemented');

    // const $or = buildSearchOr(model, params._q);
    // if ($or.length === 0) return Promise.resolve(0);
    // return model.find({ $or }).countDocuments();
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

// const buildSearchOr = (model, query) => {
//   const searchOr = Object.keys(model.attributes).reduce((acc, curr) => {
//     switch (model.attributes[curr].type) {
//       case 'biginteger':
//       case 'integer':
//       case 'float':
//       case 'decimal':
//         if (!_.isNaN(_.toNumber(query))) {
//           const mongoVersion = model.db.base.mongoDBVersion;
//           if (semver.valid(mongoVersion) && semver.gt(mongoVersion, '4.2.0')) {
//             return acc.concat({
//               $expr: {
//                 $regexMatch: {
//                   input: { $toString: `$${curr}` },
//                   regex: _.escapeRegExp(query),
//                 },
//               },
//             });
//           } else {
//             return acc.concat({ [curr]: query });
//           }
//         }
//         return acc;
//       case 'string':
//       case 'text':
//       case 'richtext':
//       case 'email':
//       case 'enumeration':
//       case 'uid':
//         return acc.concat({ [curr]: { $regex: _.escapeRegExp(query), $options: 'i' } });
//       default:
//         return acc;
//     }
//   }, []);

//   if (utils.isMongoId(query)) {
//     searchOr.push({ _id: query });
//   }

//   return searchOr;
// };

function validateRepeatableInput(value, { key, min, max, required }) {
  if (!Array.isArray(value)) {
    const err = new Error(`Component ${key} is repetable. Expected an array`);
    err.status = 400;
    throw err;
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      const err = new Error(
        `Component ${key} has invalid items. Expected each items to be objects`
      );
      err.status = 400;
      throw err;
    }
  });

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    const err = new Error(`Component ${key} must contain at least ${min} items`);
    err.status = 400;
    throw err;
  }

  if (max && value.length > max) {
    const err = new Error(`Component ${key} must contain at most ${max} items`);
    err.status = 400;
    throw err;
  }
}

function validateNonRepeatableInput(value, { key, required }) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    const err = new Error(`Component ${key} should be an object`);
    err.status = 400;
    throw err;
  }

  if (required === true && value === null) {
    const err = new Error(`Component ${key} is required`);
    err.status = 400;
    throw err;
  }
}

function validateDynamiczoneInput(value, { key, min, max, components, required }) {
  if (!Array.isArray(value)) {
    const err = new Error(`Dynamiczone ${key} is invalid. Expected an array`);
    err.status = 400;
    throw err;
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Expected each items to be objects`
      );
      err.status = 400;
      throw err;
    }

    if (!_.has(val, '__component')) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Expected each items to have a valid __component key`
      );
      err.status = 400;
      throw err;
    } else if (!components.includes(val.__component)) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Each item must have a __component key that is present in the attribute definition`
      );
      err.status = 400;
      throw err;
    }
  });

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    const err = new Error(`Dynamiczone ${key} must contain at least ${min} items`);
    err.status = 400;
    throw err;
  }
  if (max && value.length > max) {
    const err = new Error(`Dynamiczone ${key} must contain at most ${max} items`);
    err.status = 400;
    throw err;
  }
}
