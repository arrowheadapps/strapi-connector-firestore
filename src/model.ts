import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import type { AttributeKey, ConnectorOptions, Converter, ModelConfig, ModelOptions, Strapi, StrapiAttributeType, StrapiModel, StrapiModelRecord } from './types';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection, Snapshot } from './utils/queryable-collection';
import type { Firestore } from '@google-cloud/firestore';
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
    yield models[key];
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
    yield* eachModel(strapiInstance.plugins[plugin]);
  }
}


/**
 * Firestore connector implementation of the Strapi model interface.
 */
export interface FirestoreConnectorModel<T extends object = object> extends StrapiModel<T> {
  options: Required<ModelOptions>;
  config: ModelConfig;
  defaultPopulate: AttributeKey<T>[];

  assocKeys: AttributeKey<T>[];
  componentKeys: AttributeKey<T>[];
  
  isComponent: boolean;
  relations: RelationHandler<T, any>[];

  firestore: Firestore;
  db: QueryableCollection<T>;
  flattenedKey: string | null;
  converter: Converter<T>;
  timestamps: [string, string] | null;
  singleKey: string | null;

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
  strapiModel.collectionName = strapiModel.collectionName || strapiModel.globalId;
  strapiModel.attributes = strapiModel.attributes || {};

  const isComponent = strapiModel.modelType === 'component';
  const rootOpts: ModelOptions = strapiModel.options || {};
  const flattenedKey = defaultFlattenOpts(strapiModel, rootOpts, connectorOptions);

  const options: Required<ModelOptions> = {
    timestamps: rootOpts.timestamps || false,
    singleId: rootOpts.singleId || connectorOptions.singleId,
    flatten: flattenedKey != null,
    searchAttribute: defaultSearchAttrOpts(strapiModel, rootOpts),
    maxQuerySize: rootOpts.maxQuerySize ?? connectorOptions.maxQuerySize,
    ensureCompnentIds: rootOpts.ensureCompnentIds ?? connectorOptions.ensureCompnentIds,
    allowNonNativeQueries: defaultAllowNonNativeQueries(strapiModel, rootOpts, connectorOptions),
  };

  const timestamps: [string, string] | null = (typeof options.timestamps === 'boolean')
      ? (options.timestamps ? [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY] : null)
      : options.timestamps;
  options.timestamps = timestamps || false;

  const singleKey = strapiModel.kind === 'singleType' ? options.singleId : null;

  const config: ModelConfig = strapiModel.config || {};
  const converter = config.converter || { 
    toFirestore: data => data,
    fromFirestore: data => data as T,
  };

  const privateAttributes: AttributeKey<T>[] = utils.contentTypes.getPrivateAttributes(strapiModel);
  const assocKeys: AttributeKey<T>[] = strapiModel.associations.map(ast => ast.alias);
  const componentKeys = (Object.keys(strapiModel.attributes) as AttributeKey<T>[])
    .filter(key => {
      const { type } = strapiModel.attributes[key];
      return type && ['component', 'dynamiczone'].includes(type);
    });

  const defaultPopulate = strapiModel.associations
    .filter(ast => ast.autoPopulate !== false)
    .map(ast => ast.alias);


  const hasPK = (obj: any) => {
    return _.has(obj, model.primaryKey) || _.has(obj, 'id') || (model.singleKey != null);
  }

  const getPK = (obj: any) => {
    return model.singleKey || ((_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id));
  }

  const runTransaction = async (fn: (transaction: Transaction) => PromiseLike<any>) => {
    return await firestore.runTransaction(async (trans) => {
      const wrapper = new TransactionImpl(firestore, trans);
      const result = await fn(wrapper);
      await wrapper.commit();
      return result;
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
    config,
    flattenedKey,
    timestamps,
    converter,
    singleKey,
    relations: [],
    isComponent,
    
    privateAttributes,
    assocKeys,
    componentKeys,
    defaultPopulate,

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
    if (flattenedKey) {
      model.db = new QueryableFlatCollection<T>(model);
    } else {
      model.db = new QueryableFirestoreCollection<T>(model);
    }
  }

  buildRelations(model, strapi);

  return model;
}


function defaultAllowNonNativeQueries(model: StrapiModel<any>, options: ModelOptions, rootOptions: Required<ConnectorOptions>) {
  if (options.allowNonNativeQueries === undefined) {
    const rootAllow = rootOptions.allowNonNativeQueries;
    return (rootAllow instanceof RegExp)
      ? rootAllow.test(model.uid) 
      : rootAllow;
  } else {
    return options.allowNonNativeQueries;
  }
}

function defaultFlattenOpts(model: StrapiModel<any>, options: ModelOptions, rootOptions: Required<ConnectorOptions>) {
  if (options.flatten === undefined) {
    
    const [flattenedId] = rootOptions.flattenModels
      .map(testOrRegEx => {
        if ((typeof testOrRegEx === 'string') || (testOrRegEx instanceof RegExp)) {
          return {
            test: testOrRegEx,
            doc: undefined,
          }
        } else {
          return testOrRegEx;
        }
      })
      .filter(({ test }) => {
        const regex = (typeof test === 'string')
          ? new RegExp(test)
          : test;
        return regex.test(model.uid);
      })
      .map(({ doc }) => {
        return doc?.(model) || options.singleId || rootOptions.singleId;
      });

    return flattenedId || null;

  } else {
    return options.flatten
      ? options.singleId || rootOptions.singleId
      : null;
  }
}

function defaultSearchAttrOpts(model: StrapiModel<any>, options: ModelOptions) {
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
      throw new Error(`The search attribute "${searchAttr}" does not exist on the model ${model.modelName} or is of an unsupported type.`);
    }
  }

  return searchAttr;
}