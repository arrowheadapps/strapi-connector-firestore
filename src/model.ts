import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './db/queryable-firestore-collection';
import { QueryableFlatCollection } from './db/queryable-flat-collection';
import { QueryableComponentCollection } from './db/queryable-component-collection';
import type { AttributeKey, ConnectorOptions, Strapi, Model, ModelData, AttributeType, Attribute, ModelOptions, ModelBase } from 'strapi';
import type { FlattenFn, ModelTestFn } from './types';
import { populateDoc, populateSnapshots } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection } from './db/queryable-collection';
import { DocumentData, DocumentReference, Firestore } from '@google-cloud/firestore';
import type { Transaction } from './db/transaction';
import type { RelationHandler } from './utils/relation-handler';
import { buildRelations } from './relations';
import { getComponentModel } from './utils/components';
import { AttributeIndexInfo, buildIndexers, doesComponentRequireMetadata } from './utils/components-indexing';
import type { Snapshot } from './db/reference';
import { makeTransactionRunner } from './utils/transaction-runner';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';
export const PRIMARY_KEY = 'id';
export const PRIMARY_KEY_TYPE = 'string';


/**
 * Iterates each model in a the given of models.
 */
export function* eachModel(models: Strapi['models']): Generator<Model> {
  for (const key of Object.keys(models)) {
    const model = models[key];

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
export function* allModels(strapiInstance = strapi): Generator<Model> {
  // Iterate components first because subsequent models 
  // need to access the indexers
  yield* eachModel(strapiInstance.components);

  yield* eachModel(strapiInstance.models);
  yield* eachModel(strapiInstance.admin.models);
  for (const plugin of Object.keys(strapi.plugins)) {
    yield* eachModel(strapiInstance.plugins[plugin].models);
  }
}

declare module 'strapi' {
  /**
   * Firestore connector implementation of the Strapi model interface.
   */
  interface Model<T extends ModelData = ModelData> {
    options: Required<ModelOptions<T>>;
    defaultPopulate: AttributeKey<T>[];

    assocKeys: AttributeKey<T>[];
    componentKeys: AttributeKey<T>[];
    
    /**
     * If this model is a component, then this is a list of indexer
     * information for all of the indexed fields.
     */
    indexers: AttributeIndexInfo[] | undefined;
    
    isComponent: boolean;
    relations: RelationHandler<T, any>[];

    firestore: Firestore;
    db: QueryableCollection<T>;
    timestamps: [string, string] | null;

    /**
     * Gets the path of the field to store the metadata/index
     * map for the given repeatable component attribute.
     */
    getMetadataMapKey(attrKey: AttributeKey<T>): string
    hasPK(obj: any): boolean;
    getPK(obj: any): string;

    runTransaction<TResult>(fn: (transaction: Transaction) => TResult | PromiseLike<TResult>): Promise<TResult>;

    populate(data: Snapshot<T>, transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any>;
    populateAll(datas: Snapshot<T>[], transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any[]>;
  }

  /**
   * Configuration options for Firestore connector models.
   */
  interface ModelOptions<T extends ModelData, R extends DocumentData = DocumentData> {
    timestamps?: boolean | [string, string]
    singleId?: string
  
    /**
     * Override connector option per model.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    logQueries?: boolean
  
    /**
     * Override connector flattening options per model.
     * `false` to disable.
     * `true` to enable and use connector's `singleId` for the document ID.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    flatten?: boolean
  
  
    /**
     * Override connector setting per model.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    allowNonNativeQueries?: boolean
  
    /**
     * If defined, nominates a single attribute to be searched when fully-featured
     * search is disabled because of the `allowNonNativeQueries` setting.
     */
    searchAttribute?: string
  
    /**
     * Override connector setting per model.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    ensureComponentIds?: boolean
  
    /**
     * Override connector setting per model.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    maxQuerySize?: number
  
    /**
     * Override connector setting per model.
     * 
     * Defaults to `undefined` (use connector setting).
     */
    metadataField?: string | ((attrKey: AttributeKey<T>) => string)
  
    /**
     * Converter that is run upon data immediately before it
     * is stored in Firestore, and immediately after it is
     * retrieved from Firestore.
     */
    converter?: Converter<T, R>
  }
}

export interface Converter<T, R = DocumentData> {
  toFirestore?: (data: Partial<T>) => R
  fromFirestore?: (data: R) => T
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
  const models: Model[] = [];
  for (const model of allModels(args.strapi)) {
    models.push(mountModel(model, args));
  }

  // Build relations
  for (const model of models) {
    buildRelations(model, args.strapi);
  }
}


function mountModel<T extends ModelData>(mdl: ModelBase<T>, { strapi, firestore, connectorOptions }: FirestoreConnectorModelArgs): Model<T> {

  mdl.attributes = mdl.attributes || {};
  mdl.collectionName = mdl.collectionName || mdl.globalId;

  const isComponent = mdl.modelType === 'component';
  const opts: ModelOptions<T> = mdl.options || {};

  const flattening = defaultFlattenOpts(mdl, opts, connectorOptions);
  mdl.collectionName = flattening?.collectionName || mdl.collectionName;

  const options: Required<ModelOptions<T>> = {
    ...opts,
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
    populateCreatorFields: opts.populateCreatorFields || false,
    draftAndPublish: opts.draftAndPublish || false,
    privateAttributes: opts.privateAttributes || [],
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


  // Build indexers if this is a component model
  const indexers = buildIndexers(mdl);

  // Add all component's metadata keys as attributes on this model
  const getMetadataMapKey = typeof options.metadataField === 'string'
    ? (attrKey: AttributeKey<T>) => attrKey + options.metadataField
    : options.metadataField;
  Object.assign(
    mdl.attributes, 
    buildMetadataAttributes(mdl, { componentKeys, getMetadataMapKey }),
  );

  // Metadata attributes are configured as private and will
  // automatically be populated in the private attributes list
  const privateAttributes: AttributeKey<T>[] = utils.contentTypes.getPrivateAttributes(mdl);
  const assocKeys: AttributeKey<T>[] = (Object.keys(mdl.attributes) as AttributeKey<T>[])
    .filter(alias => {
      const { model, collection } = mdl.attributes[alias];
      return model || collection;
    });

  const defaultPopulate = assocKeys
    .filter(alias => {
      const attr = mdl.attributes[alias];
      return attr.autoPopulate ?? true;
    });

  const hasPK = (obj: any) => PRIMARY_KEY in obj;
  const getPK = (obj: any) => obj[PRIMARY_KEY];

  const populate = async (snap: Snapshot<T>, transaction: Transaction, populate = defaultPopulate) => {
    const data = snap.data();
    if (!data) {
      throw strapi.errors.notFound();
    }
    return await populateDoc(model, snap.ref, data, populate || model.defaultPopulate, transaction);
  };

  const populateAll = async (snaps: Snapshot<T>[], transaction: Transaction, populate = defaultPopulate) => {
    return await populateSnapshots(snaps, populate, transaction);
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



  const model: Model<T> = Object.assign(mdl, {
    orm: 'firestore',
    primaryKey: PRIMARY_KEY,
    primaryKeyType: PRIMARY_KEY_TYPE,
    firestore,
    options,
    timestamps,
    relations: [],
    isComponent,
    
    privateAttributes,
    assocKeys,
    componentKeys,
    defaultPopulate,
    indexers,
    getMetadataMapKey,

    // We assign this next
    // The constructors need these other values to be populated onto the model first
    db: undefined!,

    // We assign this later using utils.models.defineAssociations()
    associations: undefined!,

    hasPK,
    getPK,
    runTransaction: makeTransactionRunner(firestore, options, connectorOptions),
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

  model.db = isComponent
    ? new QueryableComponentCollection<T>(model)
    : (flattening 
        ? new QueryableFlatCollection<T>(model) 
        : new QueryableFirestoreCollection<T>(model)
      )

  return model;
}


function defaultAllowNonNativeQueries<T extends ModelData>(model: ModelBase<T>, options: ModelOptions<T>, connectorOptions: Required<ConnectorOptions>) {
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

function defaultFlattenOpts<T extends ModelData>(model: ModelBase<T>, options: ModelOptions<T>, connectorOptions: Required<ConnectorOptions>): FlattenResult | null {
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
        let testFn: FlattenFn
        if (typeof test === 'function') {
          testFn = test;
        } else {
          const regex = test instanceof RegExp ? test : new RegExp(test);
          testFn = (model) => regex.test(model.uid) ? singleId : null;
        }
        const flatten = testFn(model);
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

function defaultSearchAttrOpts<T extends ModelData>(model: ModelBase<T>, options: ModelOptions<T>) {
  const searchAttr = options.searchAttribute || '';

  if (searchAttr) {
    const type: AttributeType | undefined 
      = (searchAttr === PRIMARY_KEY) ? 'uid' : model.attributes[searchAttr]?.type;
    const notAllowed: AttributeType[] = [
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


/**
 * Build attributes for the metadata map fields.
 */
function buildMetadataAttributes<T extends ModelData>(model: ModelBase<T>, { componentKeys, getMetadataMapKey }: Pick<Model<T>, 'componentKeys'> & Pick<Model<T>, 'getMetadataMapKey'>): Model<T>['attributes'] {
  const attributes: Model<T>['attributes'] = {};
  if (model.modelType !== 'component') {
    for (const alias of componentKeys) {
      const attr = model.attributes[alias];
      if (!doesComponentRequireMetadata(attr)) {
        continue;
      }

      const mapKey = getMetadataMapKey(alias);
      if (mapKey in model.attributes) {
        throw new Error(`The metadata field "${mapKey}" in model "${model.uid}" conflicts with an existing attribute.`);
      }

      const models = attr.component ? [attr.component] : (attr.components || []);
      for (const modelName of models) {
        // We rely on component models being mounted first
        const { indexers } = getComponentModel(modelName);

        for (const info of indexers!) {
          for (const key of Object.keys(info.indexers)) {
            const attrPath = `${mapKey}.${key}`;
            const attrValue: Attribute = {
              collection: info.attr.model || info.attr.collection,
              via: info.attr.via,
              type: info.attr.type,
              isMeta: true,
              private: true,
              configurable: false,
              writable: false,
            };

            const existingAttrValue = attributes[attrPath];
            if (existingAttrValue) {

              if (existingAttrValue.collection 
                && attrValue.collection
                && (existingAttrValue.collection !== attrValue.collection)) {
                // Consider different collections as polymorphic
                existingAttrValue.collection = attrValue.collection = '*';
              }

              // Make sure all overlapping indexed attribute in dynamic-zone components are compatible
              // Required so that we know how to coerce the metadata map back and forth from Firestore
              if (!_.isEqual(attributes[attrPath], attrValue)) {
                throw new Error(
                  `The indexed attribute "${info.alias}" of component "${modelName}" is not compatible with an indexed attribute of another component. ` +
                  `The parent attribute is "${alias}" in model "${model.uid}"`
                );
              }
            }

            attributes[attrPath] = attrValue;

            // Set layout config on the model so that the attribute is hidden
            _.set(model, ['config', 'attributes', attrPath], { hidden: true });
          }
        }
      }

    }
  }

  return attributes;
}
