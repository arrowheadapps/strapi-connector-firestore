import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import type { AttributeKey, ConnectorOptions, Converter, ModelConfig, ModelOptions, StrapiAssociation, StrapiAttributeType, StrapiModel, StrapiRelation } from './types';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import type{ QueryableCollection, Snapshot } from './utils/queryable-collection';
import type { DocumentData, Firestore } from '@google-cloud/firestore';
import { Transaction, TransactionImpl } from './utils/transaction';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';


export interface FirestoreConnectorModelArgs {
  firestore: Firestore
  options: Required<ConnectorOptions>
  model: StrapiModel
  modelKey: string
  isComponent: boolean
}

/**
 * Firestore connector implentation of the Strapi model interface.
 */
export class FirestoreConnectorModel<T extends object = DocumentData> implements StrapiModel<T> {

  readonly orm: 'firestore';
  readonly primaryKey: string;
  readonly primaryKeyType: string;
  readonly firestore: Firestore;
  readonly options: Required<ModelOptions>;
  readonly config: ModelConfig<T>;
  readonly modelKey: string;
  readonly kind: 'collectionType' | 'singleType';
  readonly assocKeys: AttributeKey<T>[];
  readonly componentKeys: AttributeKey<T>[];
  readonly defaultPopulate: AttributeKey<T>[];
  readonly connector: string;
  readonly connection: string;
  readonly attributes: Record<AttributeKey<T>, StrapiRelation>;
  readonly privateAttributes: Record<AttributeKey<T>, StrapiRelation>;
  readonly collectionName: string;
  readonly globalId: string;
  readonly modelName: string;
  readonly uid: string;
  readonly associations: StrapiAssociation<AttributeKey<T>>[];

  readonly db: QueryableCollection<T>;
  readonly morphRelatedModels: Record<string, FirestoreConnectorModel[]>;
  readonly flattenedKey: string | null;
  readonly converter: Converter<T>;
  readonly timestamps: [string, string] | null

  private readonly singleKey: string | null;

  constructor({ modelKey, model, options, firestore, isComponent }: FirestoreConnectorModelArgs) {
    this.orm = 'firestore'; 
    this.firestore = firestore;
    this.collectionName = model.collectionName || model.globalId;
    this.globalId = model.globalId;
    this.kind = model.kind;
    this.uid = model.uid;
    this.modelName = model.modelName;
    this.primaryKey = model.primaryKey || 'id';
    this.primaryKeyType = model.primaryKeyType || 'string';
    this.connector = 'firestore';
    this.connection = model.connection;
    this.attributes = model.attributes || {};
    this.config = model.config || {};
    
    // FIXME: what is the difference from modelName?
    this.modelKey = modelKey;

    const opts: ModelOptions = model.options || {};
    this.flattenedKey = this.defaultFlattenOpts(opts, options);

    this.options = {
      timestamps: opts.timestamps || false,
      singleId: opts.singleId || options.singleId,
      flatten: this.flattenedKey != null,
      searchAttribute: this.defaultSearchAttrOpts(opts, options),
      maxQuerySize: opts.maxQuerySize ?? options.maxQuerySize,
      ensureCompnentIds: opts.ensureCompnentIds ?? options.ensureCompnentIds,
      allowNonNativeQueries: this.defaultAllowNonNativeQueries(opts, options),
    };

    this.timestamps = (typeof this.options.timestamps === 'boolean')
      ? (this.options.timestamps ? [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY] : null)
      : this.options.timestamps;
    this.singleKey = this.kind === 'singleType' ? this.options.singleId : null;

    this.converter = this.config.converter || { 
      toFirestore: data => data,
      fromFirestore: data => data as T,
    };

    if (isComponent) {
      this.db = new QueryableComponentCollection<T>(this);
    } else {
      if (this.flattenedKey) {
        this.db = new QueryableFlatCollection<T>(this);
      } else {
        this.db = new QueryableFirestoreCollection<T>(this);
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
    this.componentKeys = (Object.keys(this.attributes) as AttributeKey<T>[])
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


  async runTransaction<TResult>(fn: (transaction: Transaction) => PromiseLike<TResult>): Promise<TResult> {
    return await this.firestore.runTransaction(async (trans) => {
      const wrapper = new TransactionImpl(this.firestore, trans);
      const result = await fn(wrapper);
      wrapper.commit();
      return result;
    });
  }

  async populate(data: Snapshot<T>, transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any> {
    return await populateDoc(this, data, populate || this.defaultPopulate, transaction);
  }

  async populateAll(datas: Snapshot<T>[], transaction: Transaction, populate?: AttributeKey<T>[]): Promise<any[]> {
    return await populateDocs(this, datas, populate || this.defaultPopulate, transaction);
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


  private defaultAllowNonNativeQueries(options: ModelOptions, rootOptions: Required<ConnectorOptions>) {
    if (options.allowNonNativeQueries === undefined) {
      const rootAllow = rootOptions.allowNonNativeQueries;
      return (rootAllow instanceof RegExp)
        ? rootAllow.test(this.uid) 
        : rootAllow;
    } else {
      return options.allowNonNativeQueries;
    }
  }

  private defaultFlattenOpts(options: ModelOptions, rootOptions: Required<ConnectorOptions>) {
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

  toString(): string {
    return `${FirestoreConnectorModel.name}("${this.collectionName}")`;
  }
}
