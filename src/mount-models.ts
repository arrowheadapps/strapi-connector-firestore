import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import * as path from 'path';
import { DocumentReference, FieldValue } from '@google-cloud/firestore';
import { parseDeepReference } from './utils/queryable-collection';
import type { FirestoreConnectorContext, FirestoreConnectorModel } from './types';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';

export function mountModels(models: FirestoreConnectorContext[]) {

  function mountModel({ instance, isComponent, connection, modelKey, strapi, options }: FirestoreConnectorContext) {
    // @ts-expect-error
    const model: FirestoreConnectorModel = connection;


    const collectionName = model.collectionName || model.globalId;
    const singleKey = model.kind === 'singleType' ? options.singleId : '';

    const flatten = _.get(model, 'options.flatten', false);
    const flattenedKey = flatten === true ? path.posix.join(collectionName, options.singleId) : flatten;

    model.orm = 'firestore'; 
    model.associations = [];

    // Set the default values to model settings.
    _.defaults(model, {
      primaryKey: 'id',
      primaryKeyType: 'string',
    });

    // Use default timestamp column names if value is `true`
    if (_.get(model, 'options.timestamps', false) === true) {
      _.set(model, 'options.timestamps', [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY]);
    }
    // Use false for values other than `Boolean` or `Array`
    if (!_.isArray(_.get(model, 'options.timestamps')) && !_.isBoolean(_.get(model, 'options.timestamps'))) {
      _.set(model, 'options.timestamps', false);
    }


    // Expose ORM functions
    if (!isComponent) {

      model.firestore = instance;

      if (flattenedKey) {

        const flatDoc = instance.doc(flattenedKey);
        const collection = flatDoc.parent;

        model.db = new QueryableFlatCollection(flatDoc);
        model.doc = (id?: string) => {
          return path.posix.join(flatDoc.path, id || collection.doc().id)
        };

        model.delete = async (ref, trans) => {
          await model.setMerge(ref, FieldValue.delete(), trans);
        };

        model.create = async (ref, data, trans) => {
          // TODO:
          // Error if document already exists
          await model.setMerge(ref, data, trans);
        };
        
        // Set flattened document
        model.setMerge = async (ref, data, trans) => {
          if (typeof ref !== 'string') {
            throw new Error('Flattened collection must have reference of type `String`');
          }

          const { doc, id } = parseDeepReference(ref, instance);
          if (!doc.isEqual(flatDoc)) {
            throw new Error('Reference points to a different model');
          }
          
          if (!data) {
            data = FieldValue.delete();
          }

          if (trans) {
            // Batch all writes to documents in this flattened
            // collection and do it only once
            trans.addKeyedWrite(doc.path, 
              (ctx) => Object.assign(ctx || {}, { [id]: data }),
              (trans, ctx) => {
                trans.set(doc, ctx, { merge: true });
              }
            );
          } else {
            // Do the write immediately
            await doc.set({ [id]: data }, { merge: true });
          }
        };

      } else {

        const collection = instance.collection(collectionName);
        model.db = new QueryableFirestoreCollection(collection);
        model.doc = (id?: string) => id ? collection.doc(id) : collection.doc();

        model.delete = async (ref, trans) => {
          if (!(ref instanceof DocumentReference)) {
            throw new Error('Non-flattened collection must have reference of type `DocumentReference`');
          }
          if (trans) {
            trans.addWrite((trans)  => trans.delete(ref));
          } else {
            await ref.delete();
          }
        };

        model.create = async (ref, data, trans) => {
          if (!(ref instanceof DocumentReference)) {
            throw new Error('Non-flattened collection must have reference of type `DocumentReference`');
          }
          if (trans) {
            trans.addWrite((trans)  => trans.create(ref, data));
          } else {
            await ref.create(data);
          }
        };

        model.setMerge = async (ref, data, trans) => {
          if (!(ref instanceof DocumentReference)) {
            throw new Error('Non-flattened collection must have reference of type `DocumentReference`');
          }
          if (trans) {
            trans.addWrite((trans)  => trans.set(ref, data, { merge: true }));
          } else {
            await ref.set(data, { merge: true });
          }
        };
      }
    }
    

    /** 
      HACK:
      For `strapi-plugin-content-manager` which accesses the raw 
      ORM layer and only knows about mongoose and bookshelf connectors.
      See: https://github.com/strapi/strapi/blob/535fa25311a2caa469a13d173d710a7eba6d5ecc/packages/strapi-plugin-content-manager/services/utils/store.js#L52-L68

      It seems that the aim here is to emulate searching for 
      a prefix in the `key` field.

      return model
        .query(qb => {
          qb.where('key', 'like', `${key}%`);
        })
        .fetchAll()
        .then(config => config && config.toJSON())
        .then(results => results.map(({ value }) => JSON.parse(value)));  
    */

    
    // @ts-expect-error
    model.query = (init) => {
      let field!: string;
      let value!: string;
      let operator!: string;
      const qb = {
        where: (f: string, op: string, v: string) => {
          operator = op;
          field = f;
          value = v;
        }
      };
      init(qb);


      if ((operator !== 'like') || !/^\w+%$/.test(value)) {
        throw new Error('An update to Strapi has broken `strapi-connector-firestore`. '
          + 'Please create an issue at https://github.com/arrowheadapps/strapi-connector-firestore/issues, '
          + 'or in the meantime, revert Strapi your version to the last working version.');
      }

      // Remove '%' character from the end
      value = value.slice(0, -1);

      return {
        fetchAll: async () => {
          // Firestore method to check prefix
          // See: https://stackoverflow.com/a/46574143/1513557
          const results = await strapi.query(modelKey).find({
            [`${field}_gte`]: value,
            [`${field}_lt`]: value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1) // Lexicographically increment the last character
          });
          return {
            toJSON: () => results
          }
        }
      }
    };

    const relationalAttributes = Object.keys(model.attributes).filter(key => {
      const { type } = model.attributes[key];
      return type === undefined;
    });

    // handle relational attrs
    relationalAttributes.forEach(name => {
      // Build associations key
      utils.models.defineAssociations(modelKey.toLowerCase(), model, model.attributes[name], name);
    });


    model.assocKeys = model.associations.map(ast => ast.alias);
    model.componentKeys = Object.keys(model.attributes).filter(key =>
      ['component', 'dynamiczone'].includes(model.attributes[key].type)
    );
    model.idKeys = ['id', model.primaryKey];
    model.excludedKeys = model.assocKeys.concat(model.idKeys);
    model.defaultPopulate = model.associations
      .filter(ast => ast.autoPopulate !== false)
      .map(ast => ast.alias);
    
    model.hasPK = (obj: any) => _.has(obj, model.primaryKey) || _.has(obj, 'id') || Boolean(singleKey);
    model.getPK = (obj: any) => singleKey || ((_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id));

    model.pickRelations = values => {
      return _.pick(values, model.assocKeys);
    };

    model.omitExernalValues = values => {
      return _.omit(values, model.excludedKeys);
    };

    model.relatedNonDominantAttrs = [];
    models.forEach(({ connection }) => {
      Object.entries(connection.attributes).forEach(([ key, attr ]) => {

        if (!attr.type && !attr.via && ((attr.model || attr.collection) === modelKey)) {
          // Relation attribe refers to this models
          // `via` will be undefined for oneWay and manyWay
          model.relatedNonDominantAttrs.push({
            key,
            attr,
            modelKey: connection.globalId
          });
        }
      });
    })
  }

  return models.forEach(mountModel);
}