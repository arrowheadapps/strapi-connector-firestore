import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import type { AttributeKey, ConnectorOptions, FlattenFn, IndexerFn, ModelOptions, ModelTestFn, Strapi, StrapiAttribute, StrapiAttributeType, StrapiModel, StrapiModelRecord } from './types';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection, Snapshot } from './utils/queryable-collection';
import { DocumentReference, Firestore } from '@google-cloud/firestore';
import { Transaction, TransactionImpl } from './utils/transaction';
import type { RelationHandler } from './utils/relation-handler';
import { buildRelations } from './relations';
import { componentRequiresMetadata, getComponentModel } from './utils/components';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';


/**
 * Iterates each model in a the given of models.
 */
export function* eachModel<M extends StrapiModel = FirestoreConnectorModel>(models: StrapiModelRecord): Generator<M> {
  for (const key of Object.keys(models)) {
    const model: M = models[key];

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
export function* allModels<M extends StrapiModel = FirestoreConnectorModel>(strapiInstance = strapi): Generator<M> {
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
  
  /**
   * If this model is a component, then this is a
   * list of attributes for which to maintain an index
   * when embedded as an array (dynamic-zone or repeatable).
   */
  indexers: { key: string, fns: IndexerFn[] }[];
  
  isComponent: boolean;
  relations: RelationHandler<T, any>[];

  firestore: Firestore;
  db: QueryableCollection<T>;
  timestamps: [string, string] | null;

  /**
   * Gets the path of the field to store the metadata/index
   * map for the given repeatable component attribute.
   */
  getMetadataMapKey: (attrKey: AttributeKey<T>) => string
  hasPK(obj: any): boolean;
  getPK(obj: any): string;

  runTransaction<TResult>(fn: (transaction: Transaction) => TResult | PromiseLike<TResult>): Promise<TResult>;

  populate(data: Snapshot<T>, transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any>;
  populateAll(datas: Snapshot<T>[], transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any[]>;
}


export interface FirestoreConnectorModelArgs {
  firestore: Firestore
  connectorOptions: Required<ConnectorOptions>
  strapi: Strapi
}


/**
 * Mounts the Firestore model implementation onto the existing instance of all Strapi models.
 * They are mounted onto the existing instance because that instance is already 
 * propagated through many parts of Strapi's core.
 */
export function mountModels(args: FirestoreConnectorModelArgs) {
  // Mount initialise all models onto the existing model instances
  const models: FirestoreConnectorModel[] = [];
  for (const model of allModels<StrapiModel>(args.strapi)) {
    models.push(mountModel(model, args));
  }

  // Build relations
  for (const model of models) {
    buildRelations(model, args.strapi);
  }
}


function mountModel<T extends object>(mdl: StrapiModel<T>, { strapi, firestore, connectorOptions }: FirestoreConnectorModelArgs<T>): FirestoreConnectorModel<T> {

  mdl.orm = 'firestore';
  mdl.primaryKey = mdl.primaryKey || 'id';
  mdl.primaryKeyType = mdl.primaryKeyType || 'string';
  mdl.attributes = mdl.attributes || {};
  mdl.collectionName = mdl.collectionName || mdl.globalId;

  const isComponent = mdl.modelType === 'component';
  const opts: ModelOptions<T> = mdl.options || {};

  const flattening = defaultFlattenOpts(mdl, opts, connectorOptions);
  mdl.collectionName = flattening?.collectionName || mdl.collectionName;

  const options: Required<ModelOptions<T>> = {
    timestamps: opts.timestamps || false,
    logQueries: opts.logQueries ?? connectorOptions.logQueries,
    singleId: flattening?.singleId || opts.singleId || connectorOptions.singleId,
    flatten: flattening != null,
    searchAttribute: defaultSearchAttrOpts(mdl, opts),
    maxQuerySize: flattening ? 0 : opts.maxQuerySize ?? connectorOptions.maxQuerySize,
    ensureComponentIds: opts.ensureComponentIds ?? connectorOptions.ensureComponentIds,
    allowNonNativeQueries: defaultAllowNonNativeQueries(mdl, opts, connectorOptions),
    metadataField: opts.metadataField || connectorOptions.metadataField,
    converter: opts.converter || {},
  };

  const timestamps: [string, string] | null = (typeof options.timestamps === 'boolean')
      ? (options.timestamps ? [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY] : null)
      : options.timestamps;
  options.timestamps = timestamps || false;

  const componentKeys = (Object.keys(mdl.attributes) as AttributeKey<T>[])
    .filter(key => {
      const { type } = mdl.attributes[key];
      return type && ['component', 'dynamiczone'].includes(type);
    });


  // TODO:
  // Add all component's metadata keys as attributes on this model

  const getMetadataMapKey = typeof options.metadataField === 'string'
    ? (attrKey: AttributeKey<T>) => attrKey + options.metadataField
    : options.metadataField;

  const attrsRequiringMetadata = componentKeys
    .map(alias => ({ alias, attr: mdl.attributes[alias]}))
    .filter(({ attr }) => componentRequiresMetadata(attr));

  for (const {} of attrsRequiringMetadata) {
    Object.assign(mdl.attributes, getIndexedAttributes())
  }

  const componentMapKeys = attrsRequiringMetadata
    .map(({ alias, attr }) => {
      const models = attr.component
        ? [getComponentModel(attr.component)]
        : (attr.components || []).map(getComponentModel);
      
      models.forEach(componentModel => {
        
      });
      
      getMetadataMapKey(key)
    })
    
  const metadataKeys = componentKeys
    .map(alias)
    
  const privateAttributes: AttributeKey<T>[] = _.uniq(
    utils.contentTypes.getPrivateAttributes(mdl).concat(componentMapKeys)
  );
  const assocKeys: AttributeKey<T>[] = (Object.keys(mdl.attributes) as AttributeKey<T>[])
    .filter(alias => {
      const { model, collection } = mdl.attributes[alias];
      return model || collection;
    });
  
  const indexedKeys = (Object.keys(mdl.attributes) as AttributeKey<T>[])
    .filter(key => {
      const { indexed, indexedBy } = mdl.attributes[key];
      return indexed || indexedBy;
    });
  const indexedAttributes = isComponent
    ? _.uniq(assocKeys.concat(indexedKeys))
    : [];


  const defaultPopulate = assocKeys
    .filter(alias => {
      const attr = mdl.attributes[alias];
      return attr.autoPopulate ?? true;
    });


  const hasPK = (obj: any) => {
    return _.has(obj, mdl.primaryKey) || _.has(obj, 'id');
  }

  const getPK = (obj: any) => {
    return ((_.has(obj, mdl.primaryKey) ? obj[mdl.primaryKey] : obj.id));
  }

  const runTransaction = async (fn: (transaction: Transaction) => PromiseLike<any>) => {
    let attempt = 0;
    return await firestore.runTransaction(async (trans) => {
      if ((attempt > 0) && connectorOptions.useEmulator) {
        // Random backoff for contested transactions only when running on the emulator
        // The production server has deadlock avoidance but the emulator currently doesn't
        // See https://github.com/firebase/firebase-tools/issues/1629#issuecomment-525464351
        // See https://github.com/firebase/firebase-tools/issues/2452
        const ms = Math.random() * 1000 * attempt;
        strapi.log.warn(`There is contention on a document and the Firestore emulator is getting deadlocked. Waiting ${ms.toFixed(0)}ms.`);
        await new Promise(resolve => setTimeout(resolve, ms));
      }

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
        const results = await strapi.query(mdl.modelName).find({
          [`${field}_gte`]: gte,
          [`${field}_lt`]: lt,
        });
        return {
          toJSON: () => results
        }
      }
    };
  };



  const model: FirestoreConnectorModel<T> = Object.assign(mdl, {
    firestore,
    options,
    timestamps,
    relations: [],
    isComponent,
    
    privateAttributes,
    assocKeys,
    componentKeys,
    defaultPopulate,
    indexedKeys,
    getMetadataMapKey,

    // We assign this next
    // The constructors need these other values to be populated onto the model first
    db: null!,

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

interface AttributeIndexInfo {
  alias: string
  attr: StrapiAttribute
  defaultIndexer?: string
  indexers: {
    [key: string]: IndexerFn
  }
}

/**
 * Build the me
 */
function getMetaAttributes<T extends object>(model: FirestoreConnectorModel<T>): { [key: string]: StrapiAttribute } {
  const attributes: { [key: string]: StrapiAttribute } = {};
  if (model.modelType !== 'component') {
    
    
  }

  return attributes;
}

/**
 * Build indexers for all the indexed attributes
 * in a component model.
 */
function getIndexedAttributes<T extends object>(model: FirestoreConnectorModel<T>): AttributeIndexInfo[] {

  const infos: AttributeIndexInfo[] = [];

  for (const alias of Object.keys(model.attributes)) {
    const attr = model.attributes[alias];
    const isRelation = attr.model || attr.collection;
    
    if (isRelation || attr.index) {
      let defaultIndexer: string | undefined;
      let indexers: { [key: string]: IndexerFn };

      if (typeof attr.index === 'object') {
        indexers = {};
        for (const key of Object.keys(attr.index)) {
          const indexer = attr.index[key];
          if (indexer) {
            if (typeof indexer === 'function') {
              indexers[key] = indexer;
            } else {
              indexers[key] = value => value;
              if (!defaultIndexer) {
                defaultIndexer = key;
              }
            }
          }
        }

        // Ensure there is a default indexer for relation types
        if (isRelation && !defaultIndexer) {
          defaultIndexer = alias;
          indexers[alias] = value => value;
        }

      } else {
        const key = (typeof attr.index === 'string') ? attr.index : alias;
        defaultIndexer = key;
        indexers = {
          [key]: value => value,
        };
      }

      infos.push({
        alias,
        attr,
        defaultIndexer,
        indexers,
      });
    }
  }

  return infos;
}