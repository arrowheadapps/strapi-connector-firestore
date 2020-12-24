import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import type { ConnectorOptions, Converter, ModelConfig, ModelOptions, StrapiAssociation, StrapiAttributeType, StrapiModel, StrapiRelation } from './types';
import { TransactionWrapper, TransactionWrapperImpl } from './utils/transaction-wrapper';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection, Snapshot } from './utils/queryable-collection';
import type { DocumentData, Firestore } from '@google-cloud/firestore';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';


export interface FirestoreConnectorModelOpts {
  firestore: Firestore
  options: ConnectorOptions
  connection: StrapiModel
  modelKey: string
  isComponent: boolean
}

export class FirestoreConnectorModel<T = DocumentData> implements StrapiModel {

  readonly orm: 'firestore';
  readonly primaryKey: string;
  readonly primaryKeyType: string;
  readonly firestore: Firestore;
  readonly options: Required<ModelOptions>;
  readonly config: ModelConfig<T>;
  readonly modelKey: string;
  readonly kind: 'collectionType' | 'singleType';
  readonly assocKeys: string[];
  readonly componentKeys: string[];
  readonly defaultPopulate: string[];
  readonly connector: string;
  readonly connection: string;
  readonly attributes: Record<string, StrapiRelation>;
  readonly privateAttributes: Record<string, StrapiRelation>;
  readonly collectionName: string;
  readonly globalId: string;
  readonly modelName: string;
  readonly uid: string;
  readonly associations: StrapiAssociation[];

  readonly db: QueryableCollection<T>;
  readonly morphRelatedModels: Record<string, FirestoreConnectorModel[]>;
  readonly flattenedKey: string | null;
  readonly converter: Converter<T>;

  private readonly singleKey: string | null;

  constructor({ modelKey, connection, options, firestore, isComponent }: FirestoreConnectorModelOpts) {

    this.orm = 'firestore'; 
    this.firestore = firestore;
    this.collectionName = connection.collectionName || connection.globalId;
    this.globalId = connection.globalId;
    this.kind = connection.kind;
    this.uid = connection.uid;
    this.modelName = connection.modelName;
    this.primaryKey = connection.primaryKey || 'id';
    this.primaryKeyType = connection.primaryKeyType || 'string';
    this.connector = connection.connector;
    this.connection = connection.connection;
    this.attributes = connection.attributes;
    this.config = connection.config;
    
    // FIXME: what is the difference from modelName?
    this.modelKey = modelKey;

    const opts: ModelOptions = connection.options || {};
    this.flattenedKey = this.defaultFlattenOpts(opts, options);

    this.options = {
      timestamps: (opts.timestamps === true) ? [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY] : false,
      singleId: opts.singleId || options.singleId,
      flatten: this.flattenedKey != null,
      searchAttribute: this.defaultSearchAttrOpts(opts, options),
      maxQuerySize: opts.maxQuerySize ?? options.maxQuerySize,
      ensureCompnentIds: opts.ensureCompnentIds ?? options.ensureCompnentIds,
      allowNonNativeQueries: this.defaultAllowNonNativeQueries(opts, options),
    };

    this.singleKey = this.kind === 'singleType' ? this.options.singleId : null;

    const cfg: ModelConfig<T> = connection.config || {};
    this.converter = cfg.converter || { 
      toFirestore: data => data,
      fromFirestore: data => data as T,
    };

    if (isComponent) {
      this.db = new QueryableComponentCollection<T>(this);
    } else {
      if (this.options.flatten) {
        this.db = new QueryableFlatCollection<T>(this, options);
      } else {
        this.db = new QueryableFirestoreCollection<T>(this, options);
      }
    }


    this.associations = [];
    Object.keys(this.attributes)
      .filter(key => {
        const { type } = this.attributes[key];
        return type === undefined;
      })
      .forEach(name => {
        // Build associations key
        utils.models.defineAssociations(modelKey.toLowerCase(), this, this.attributes[name], name);
      });


    this.privateAttributes = utils.contentTypes.getPrivateAttributes(this);
    this.assocKeys = this.associations.map(ast => ast.alias);
    this.componentKeys = Object
      .keys(this.attributes)
      .filter(key =>
        ['component', 'dynamiczone'].includes(this.attributes[key].type)
      );

    this.defaultPopulate = this.associations
      .filter(ast => ast.autoPopulate !== false)
      .map(ast => ast.alias);

    // FIXME:
    // Correlate all models that relate to any polymorphic
    // relations in this model
    this.morphRelatedModels = {};
  }

  hasPK(obj: any): boolean {
    return _.has(obj, this.primaryKey) || _.has(obj, 'id') || (this.singleKey != null);
  }

  getPK(obj: any): string {
    return this.singleKey || ((_.has(obj, this.primaryKey) ? obj[this.primaryKey] : obj.id));
  }


  async runTransaction<TResult>(fn: (transaction: TransactionWrapper) => Promise<TResult>): Promise<TResult> {
    return await this.firestore.runTransaction(async (trans) => {
      const wrapper = new TransactionWrapperImpl(trans);
      const result = await fn(wrapper);
      wrapper.doWrites();
      return result;
    });
  }

  async populate(data: Snapshot<T>, transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<any> {
    return await populateDoc(this, data, (populate as string[]) || this.defaultPopulate, transaction);
  }

  async populateAll(datas: Snapshot<T>[], transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<any[]> {
    return await populateDocs(this, datas, (populate as string[]) || this.defaultPopulate, transaction);
  }



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
  query(init: (qb: any) => void) {
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
        const results = await strapi.query(this.modelKey).find({
          [`${field}_gte`]: gte,
          [`${field}_lt`]: lt,
        });
        return {
          toJSON: () => results
        }
      }
    };
  }


  private defaultAllowNonNativeQueries(options: ModelOptions, rootOptions: ConnectorOptions) {
    if (options.allowNonNativeQueries === undefined) {
      const rootAllow = rootOptions.allowNonNativeQueries;
      return (rootAllow instanceof RegExp)
        ? rootAllow.test(this.uid) 
        : rootAllow;
    } else {
      return options.allowNonNativeQueries;
    }
  }

  private defaultFlattenOpts(options: ModelOptions, rootOptions: ConnectorOptions) {
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
          return regex.test(this.uid);
        })
        .map(({ doc }) => {
          return doc?.(this) || options.singleId || rootOptions.singleId;
        });
  
      return flattenedId || null;

    } else {
      return options.flatten
        ? options.singleId || rootOptions.singleId
        : null;
    }
  }

  private defaultSearchAttrOpts(options: ModelOptions, rootOptions: ConnectorOptions) {
    const searchAttr = options.searchAttribute || '';

    if (searchAttr) {
      const type: StrapiAttributeType = (searchAttr === this.primaryKey)
        ? 'uid'
        : this.attributes[searchAttr]?.type;
      const notAllowed: StrapiAttributeType[] = [
        'password',
        'dynamiczone',
        'component',
      ];
      if (!type || notAllowed.includes(type)) {
        throw new Error(`The search attribute "${searchAttr}" does not exist on the model ${this.modelName} or is of an unsupported type.`);
      }
    }

    return searchAttr;
  }
}
