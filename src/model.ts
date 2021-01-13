import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import type { AttributeKey, ConnectorOptions, FlattenFn, ModelOptions, ModelTestFn, Strapi, StrapiAttributeType, StrapiModel, StrapiModelRecord } from './types';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection, Snapshot } from './utils/queryable-collection';
import { DocumentReference, Firestore } from '@google-cloud/firestore';
import { Transaction, TransactionImpl } from './utils/transaction';
import type { RelationHandler } from './utils/relation-handler';
import { buildRelations } from './relations';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';


/**
 * Iterates each model in a the given of models.
 */
export function* eachModel(models: StrapiModelRecord): Generator<FirestoreConnectorModel<any>> {
  for (const key of Object.keys(models)) {
    const model: FirestoreConnectorModel<any> = models[key];

    // The internal core_store and webhooks models don't
    // have modelKey set, which breaks some of our code
    model.modelName = model.modelName || key;

    yield model;
  }
}

/**
 * Iterates all models in the Strapi instance.
 * @param strapiInstance Defaults to global Strapi
 */
export function* allModels(strapiInstance = strapi): Generator<FirestoreConnectorModel<any>> {
  yield* eachModel(strapiInstance.models);
  yield* eachModel(strapiInstance.components);
  yield* eachModel(strapiInstance.admin.models);
  for (const plugin of Object.keys(strapi.plugins)) {
    yield* eachModel(strapiInstance.plugins[plugin].models);
  }
}


/**
 * Firestore connector implementation of the Strapi model interface.
 */
export interface FirestoreConnectorModel<T extends object = object> extends StrapiModel<T> {
  options: Required<ModelOptions<T>>;
  defaultPopulate: AttributeKey<T>[];

  assocKeys: AttributeKey<T>[];
  componentKeys: AttributeKey<T>[];
  
  isComponent: boolean;
  relations: RelationHandler<T, any>[];

  /**
   * If this model is a component, then this is a
   * list of attributes for which to maintain an index
   * when embedded as an array (dynamic-zone or repeatable).
   */
  indexedAttributes: AttributeKey<T>[];
  getMetadataField: (attrKey: AttributeKey<T>) => string

  firestore: Firestore;
  db: QueryableCollection<T>;
  timestamps: [string, string] | null;

  hasPK(obj: any): boolean;
  getPK(obj: any): string;

  runTransaction<TResult>(fn: (transaction: Transaction) => TResult | PromiseLike<TResult>): Promise<TResult>;

  populate(data: Snapshot<T>, transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any>;
  populateAll(datas: Snapshot<T>[], transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any[]>;
}


export interface FirestoreConnectorModelArgs<T extends object> {
  firestore: Firestore
  connectorOptions: Required<ConnectorOptions>
  model: StrapiModel<T>
  strapi: Strapi
}

/**
 * Mounts the Firestore model implementation onto the existing instance.
 * It is mounted onto the existing instance because that instance is already 
 * propagated through many parts of Strapi's core.
 */
export function mountModel<T extends object>({ strapi, model: strapiModel, firestore, connectorOptions }: FirestoreConnectorModelArgs<T>): FirestoreConnectorModel<T> {

  strapiModel.orm = 'firestore';
  strapiModel.primaryKey = strapiModel.primaryKey || 'id';
  strapiModel.primaryKeyType = strapiModel.primaryKeyType || 'string';
  strapiModel.attributes = strapiModel.attributes || {};

  const isSingle = strapiModel.kind === 'singleType';
  const isComponent = strapiModel.modelType === 'component';
  const opts: ModelOptions<T> = strapiModel.options || {};
  const flattening = defaultFlattenOpts(strapiModel, opts, connectorOptions);

  strapiModel.collectionName = flattening?.collectionName || strapiModel.collectionName || strapiModel.globalId;


  const options: Required<ModelOptions<T>> = {
    timestamps: opts.timestamps || false,
    logQueries: opts.logQueries ?? connectorOptions.logQueries,
    singleId: flattening?.singleId || opts.singleId || connectorOptions.singleId,
    flatten: flattening != null,
    searchAttribute: defaultSearchAttrOpts(strapiModel, opts),
    maxQuerySize: flattening ? 0 : opts.maxQuerySize ?? connectorOptions.maxQuerySize,
    ensureComponentIds: opts.ensureComponentIds ?? connectorOptions.ensureComponentIds,
    allowNonNativeQueries: defaultAllowNonNativeQueries(strapiModel, opts, connectorOptions),
    metadataField: opts.metadataField || connectorOptions.metadataField,
    converter: opts.converter || { 
      toFirestore: data => data,
      fromFirestore: data => data as T,
    },
  };

  const timestamps: [string, string] | null = (typeof options.timestamps === 'boolean')
      ? (options.timestamps ? [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY] : null)
      : options.timestamps;
  options.timestamps = timestamps || false;

  const componentKeys = (Object.keys(strapiModel.attributes) as AttributeKey<T>[])
    .filter(key => {
      const { type } = strapiModel.attributes[key];
      return type && ['component', 'dynamiczone'].includes(type);
    });

  const getMetadataField = typeof options.metadataField === 'string'
    ? (attrKey: AttributeKey<T>) => attrKey + options.metadataField
    : options.metadataField;
  const componentMapKeys = componentKeys.map(key => getMetadataField(key));
  const privateAttributes: AttributeKey<T>[] = _.uniq(
    utils.contentTypes.getPrivateAttributes(strapiModel).concat(componentMapKeys)
  );
  const assocKeys: AttributeKey<T>[] = (Object.keys(strapiModel.attributes) as AttributeKey<T>[])
    .filter(alias => {
      const { model, collection } = strapiModel.attributes[alias];
      return model || collection;
    });
  
  const indexedKeys = (Object.keys(strapiModel.attributes) as AttributeKey<T>[])
    .filter(key => {
      const { indexed, indexedBy } = strapiModel.attributes[key];
      return indexed || indexedBy;
    });
  const indexedAttributes = isComponent
    ? _.uniq(assocKeys.concat(indexedKeys))
    : [];


  const defaultPopulate = assocKeys
    .filter(alias => {
      const attr = strapiModel.attributes[alias];
      return attr.autoPopulate ?? true;
    });


  const hasPK = (obj: any) => {
    return _.has(obj, model.primaryKey) || _.has(obj, 'id') || (options.singleId != null);
  }

  const getPK = (obj: any) => {
    return isSingle || ((_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id));
  }

  const runTransaction = async (fn: (transaction: Transaction) => PromiseLike<any>) => {
    let attempt = 0;
    return await firestore.runTransaction(async (trans) => {
      const wrapper = new TransactionImpl(firestore, trans, connectorOptions.logTransactionStats, ++attempt);
      const path = await fn(wrapper);
      await wrapper.commit();
      return path;
    });
  };

  const populate = async (data: Snapshot<T>, transaction: Transaction, populate?: AttributeKey<T>[]) => {
    return await populateDoc(model, data, populate || model.defaultPopulate, transaction);
  };

  const populateAll = async (datas: Snapshot<T>[], transaction: Transaction, populate?: AttributeKey<T>[]) => {
    return await populateDocs(model, datas, populate || model.defaultPopulate, transaction);
  };

  const query = (init: (qb: any) => void) => {
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
        const results = await strapi.query(strapiModel.modelName).find({
          [`${field}_gte`]: gte,
          [`${field}_lt`]: lt,
        });
        return {
          toJSON: () => results
        }
      }
    };
  };


  let db: QueryableCollection<T> | undefined;

  const model = Object.assign(strapiModel, {
    firestore,
    options,
    timestamps,
    relations: (strapiModel as FirestoreConnectorModel<T>).relations,
    isComponent,
    
    privateAttributes,
    assocKeys,
    componentKeys,
    defaultPopulate,
    indexedAttributes,
    getMetadataField,

    // We assign this next
    db: db!,

    hasPK,
    getPK,
    runTransaction,
    populate,
    populateAll,

    /**
     * HACK:
     * For `strapi-plugin-content-manager` which accesses the raw 
     * ORM layer and only knows about mongoose and bookshelf connectors.
     * See: https://github.com/strapi/strapi/blob/535fa25311a2caa469a13d173d710a7eba6d5ecc/packages/strapi-plugin-content-manager/services/utils/store.js#L52-L68
     * 
     * It seems that the aim here is to emulate searching for 
     * a prefix in the `key` field.
     * 
     * ```
     * return model
     *  .query(qb => {
     *    qb.where('key', 'like', `${key}%`);
     *  })
     *  .fetchAll()
     *  .then(config => config && config.toJSON())
     *  .then(results => results.map(({ value }) => JSON.parse(value)));
     * ```
     */
    query,
  });

  if (isComponent) {
    model.db = new QueryableComponentCollection<T>(model);
  } else {
    if (flattening) {
      model.db = new QueryableFlatCollection<T>(model);
    } else {
      model.db = new QueryableFirestoreCollection<T>(model);
    }
  }

  buildRelations(model, strapi);

  return model;
}


function defaultAllowNonNativeQueries<T extends object>(model: StrapiModel<T>, options: ModelOptions<T>, connectorOptions: Required<ConnectorOptions>) {
  if (options.allowNonNativeQueries === undefined) {
    const rootAllow = connectorOptions.allowNonNativeQueries;
    if (typeof rootAllow === 'boolean') {
      return rootAllow;
    }
    const tests = _.castArray(rootAllow)
      .map(test => {
        if (typeof test === 'function') {
          return test;
        }
        const regex = test instanceof RegExp ? test : new RegExp(test);
        const tester: ModelTestFn = (model) => regex.test(model.uid);
        return tester;
      })
      .map(tester => {
        return tester(model);
      });

    return tests.some(t => t);
  } else {
    return options.allowNonNativeQueries;
  }
}

interface FlattenResult {
  collectionName: string | null
  singleId: string
}

function defaultFlattenOpts<T extends object>(model: StrapiModel<T>, options: ModelOptions<T>, connectorOptions: Required<ConnectorOptions>): FlattenResult | null {
  const singleId = options.singleId || connectorOptions.singleId;
  const result: FlattenResult = {
    collectionName: null,
    singleId,
  };

  if (options.flatten === undefined) {
    const { flattenModels } = connectorOptions;

    if (typeof flattenModels === 'boolean') {
      return flattenModels ? result : null;
    }
    
    const tests = _.castArray(flattenModels)
      .map(test => {
        if (typeof test === 'function') {
          return test;
        }
        const regex = test instanceof RegExp ? test : new RegExp(test);
        const tester: FlattenFn = (model) => regex.test(model.uid) ? singleId : null;
        return tester;
      })
      .map(tester => {
        const flatten = tester(model);
        if (!flatten) {
          return null;
        }
        if (flatten instanceof DocumentReference) {
          return flatten.path;
        }
        return (typeof flatten === 'string') ?  flatten : singleId;
      });
    
    const path = tests.find(test => test != null);
    if (path) {
      const i = path.lastIndexOf('/');
      return {
        collectionName: (i === -1) ? null : path.slice(0, i),
        singleId: (i === -1) ? path : path.slice(i + 1),
      };
    }
    return null;
  } else {
    return options.flatten ? result : null;
  }
}

function defaultSearchAttrOpts<T extends object>(model: StrapiModel<any>, options: ModelOptions<T>) {
  const searchAttr = options.searchAttribute || '';

  if (searchAttr) {
    const type: StrapiAttributeType | undefined = (searchAttr === model.primaryKey)
      ? 'uid'
      : model.attributes[searchAttr]?.type;
    const notAllowed: StrapiAttributeType[] = [
      'password',
      'dynamiczone',
      'component',
    ];
    if (!type || notAllowed.includes(type)) {
      throw new Error(`The search attribute "${searchAttr}" does not exist on the model ${model.uid} or is of an unsupported type.`);
    }
  }

  return searchAttr;
}