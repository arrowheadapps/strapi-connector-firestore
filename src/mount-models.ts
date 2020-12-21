import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import * as path from 'path';
import { DocumentReference, FieldValue, FirestoreDataConverter, DocumentData } from '@google-cloud/firestore';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import type { FirestoreConnectorContext, FirestoreConnectorModel, ModelOptions, StrapiAttributeType } from './types';
import { TransactionWrapper, TransactionWrapperImpl } from './utils/transaction-wrapper';
import { populateDocs } from './populate';
import { coerceModelFromFirestore, coerceModelToFirestore } from './utils/coerce';
import { DeepReference } from './utils/deep-reference';
import { buildPrefixQuery } from './utils/prefix-query';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';

const defaultOptions: ModelOptions = {
  timestamps: false,
  allowNonNativeQueries: undefined,
  flatten: undefined
};

export function mountModels(models: FirestoreConnectorContext[]) {

  function mountModel({ instance, isComponent, connection, modelKey, strapi, options }: FirestoreConnectorContext) {
    // @ts-expect-error
    const model: FirestoreConnectorModel = connection;
    const collectionName = model.collectionName || model.globalId;

    // Set the default values to model settings
    _.defaults(model, {
      primaryKey: 'id',
      primaryKeyType: 'string',
    });

    // Setup default options
    if (!model.options) {
      model.options = {};
    }
    _.defaults(model.options, defaultOptions);
    if (model.options.timestamps === true) {
      model.options.timestamps = [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY];
    }
    if (!model.options.singleId) {
      model.options.singleId = options.singleId;
    }
    if (model.options.flatten === undefined) {
      const match = options.flattenModels.find(testOrRegEx => {
        const regexRaw = ((typeof testOrRegEx === 'string') || (testOrRegEx instanceof RegExp))
          ? testOrRegEx
          : testOrRegEx.test;
        const regex = typeof regexRaw === 'string'
          ? new RegExp(regexRaw)
          : regexRaw;
        
        return regex.test(connection.uid);
      });
      if (match) {
        const doc = (match as any).doc?.(connection);
        model.options.flatten = doc || true;
      }
    }
    if (model.options.allowNonNativeQueries === undefined) {
      const rootAllow = options.allowNonNativeQueries;
      model.options.allowNonNativeQueries = (rootAllow instanceof RegExp) ? rootAllow.test(model.uid) : rootAllow;
    }
    if (model.options.searchAttribute) {
      const attr = model.options.searchAttribute;
      const type: StrapiAttributeType = (attr === model.primaryKey)
        ? 'uid'
        : model.attributes[attr]?.type;
      const notAllowed: StrapiAttributeType[] = [
        'password',
        'dynamiczone',
        'component',
      ];
      if (!type || notAllowed.includes(type)) {
        throw new Error(`The search attribute "${attr}" does not exist on the model ${model.globalId} or is of an unsupported type.`);
      }
    }
    if (model.options.ensureCompnentIds === undefined) {
      model.options.ensureCompnentIds = options.ensureCompnentIds;
    }
    if (model.options.maxQuerySize === undefined) {
      model.options.maxQuerySize = options.maxQuerySize;
    }
    
    const userConverter = model.config?.converter || { 
      toFirestore: data => data,
      fromFirestore: data => data,
    };

    const singleKey = model.kind === 'singleType' ? model.options.singleId : '';
    const flattenedKey = model.options.flatten ? path.posix.join(collectionName, model.options.singleId) : '';

    model.orm = 'firestore'; 
    model.associations = [];

    // Expose ORM functions
    if (!isComponent) {

      model.firestore = instance;
      model.runTransaction = (fn) => {
        return instance.runTransaction(async (trans) => {
          const wrapper = new TransactionWrapperImpl(trans);
          const result = await fn(wrapper);
          wrapper.doWrites();
          return result;
        });
      };

      model.populate = async (data, transaction, populateFields) => {
        const [result] = await populateDocs(model, [data], (populateFields as string[]) || model.defaultPopulate, transaction);
        return result;
      };

      model.populateAll = (datas, transaction, populateFields) => {
        return populateDocs(model, datas, (populateFields as string[]) || model.defaultPopulate, transaction);
      };

      if (flattenedKey) {

        const conv: FirestoreDataConverter<DocumentData> = {
          toFirestore: data => _.mapValues(data, d => userConverter.toFirestore(coerceModelToFirestore(model, d))),
          fromFirestore: data => _.mapValues(data.data(), (d, id) => coerceModelFromFirestore(model, id, userConverter.fromFirestore(d))),
        };
        const flatDoc = instance.doc(flattenedKey).withConverter(conv);
        const collection = flatDoc.parent;

        (model as any).flatDoc = flatDoc;

        model.db = new QueryableFlatCollection(flatDoc);
        model.autoId = () => collection.doc().id;
        model.doc = (id?: string) => {
          return new DeepReference(flatDoc, id?.toString() || model.autoId());
        };

        model.delete = async (ref, trans) => {
          await set(ref, FieldValue.delete(), trans, false);
        };

        model.create = async (ref, data, trans) => {
          // TODO:
          // Error if document already exists
          await set(ref, data, trans, false);
        };

        model.update = async (ref, data, trans) => {
          // TODO:
          // Error if document doesn't exist
          await set(ref, data, trans, false);
        };


        // Set flattened document
        model.setMerge = async (ref, data, trans) => {
          await set(ref, data, trans, true);
        };

        let _ensureDocument: Promise<any> | null = null;
        const ensureDocument = async () => {
          // Set and merge with empty object
          // This will ensure that the document exists using
          // as single write operation
          if (!_ensureDocument) {
            _ensureDocument = flatDoc.set({}, { merge: true })
              .catch((err) => {
                _ensureDocument = null;
                throw err;
              });
          }
          return _ensureDocument;
        };
        
        const set = async (ref, data, trans: TransactionWrapper | undefined, merge: boolean) => {
          if (!(ref instanceof DeepReference)) {
            throw new Error('Flattened collection must have reference of type `DeepReference`');
          }
          if (!ref.doc.isEqual(flatDoc)) {
            throw new Error('Reference points to a different model');
          }
          if (!data || (typeof data !== 'object')) {
            throw new Error(`Invalid data provided to Firestore. It must be an object but it was: ${JSON.stringify(data)}`);
          }
          
          if (FieldValue.delete().isEqual(data)) {
            data = { [ref.id]: FieldValue.delete() };
          } else {
            if (merge) {
              // Flatten into key-value pairs to merge the fields
              const pairs = _.toPairs(data);
              data = {};
              pairs.forEach(([path, val]) => {
                data[`${ref.id}.${path}`] = val;
              });
            } else {
              data = { [ref.id]: data };
            }
          }

          // Ensure document exists
          // This costs one write operation at startup only
          await ensureDocument();



          // HACK:
          // It seems that Firestore does not call the converter
          // for update operations?
          data = conv.toFirestore(data);

          if (trans) {
            // Batch all writes to documents in this flattened
            // collection and do it only once
            (trans as TransactionWrapperImpl).addKeyedWrite(flatDoc.path, 
              (ctx) => Object.assign(ctx || {}, data),
              (trans, ctx) => {
                trans.update(flatDoc, ctx);
              }
            );
          } else {
            // Do the write immediately
            await flatDoc.update(data);
          }
        };

      } else {

        const conv: FirestoreDataConverter<DocumentData> = {
          toFirestore: data => userConverter.toFirestore(coerceModelToFirestore(model, data)),
          fromFirestore: snap => coerceModelFromFirestore(model, snap.id, userConverter.fromFirestore(snap.data())),
        };

        const collection = instance.collection(collectionName).withConverter(conv);
        model.db = new QueryableFirestoreCollection(collection, model.options.allowNonNativeQueries, model.options.maxQuerySize);
        model.autoId = () => collection.doc().id;
        model.doc = (id?: string) => id ? collection.doc(id.toString()) : collection.doc();

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

        model.update = async (ref, data, trans) => {
          if (!(ref instanceof DocumentReference)) {
            throw new Error('Non-flattened collection must have reference of type `DocumentReference`');
          }

          // HACK:
          // It seems that Firestore does not call the converter
          // for update operations?
          data = conv.toFirestore(data);

          if (trans) {
            trans.addWrite((trans)  => trans.update(ref, data));
          } else {
            await ref.update(data);
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
    } else {

      // Used to generate IDs for embedded components
      model.autoId = () => instance.collection(model.collectionName).doc().id;
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
          const { gte, lt } = buildPrefixQuery(value);
          const results = await strapi.query(modelKey).find({
            [`${field}_gte`]: gte,
            [`${field}_lt`]: lt,
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

    model.privateAttributes = utils.contentTypes.getPrivateAttributes(model);
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