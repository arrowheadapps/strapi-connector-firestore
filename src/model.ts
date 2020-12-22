import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { QueryableFirestoreCollection } from './utils/queryable-firestore-collection';
import { QueryableFlatCollection } from './utils/queryable-flat-collection';
import { ConnectorOptions, FirestoreConnectorContext, FirestoreConnectorModel, ModelConfig, ModelOptions, StrapiAssociation, StrapiAttributeType, StrapiModel, StrapiRelation } from './types';
import { TransactionWrapper, TransactionWrapperImpl } from './utils/transaction-wrapper';
import { populateDoc, populateDocs } from './populate';
import { buildPrefixQuery } from './utils/prefix-query';
import { QueryableComponentCollection } from './utils/queryable-component-collection';
import { QueryableCollection, Snapshot } from './utils/queryable-collection';
import type { Firestore } from '@google-cloud/firestore';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';

const defaultOptions: ModelOptions = {
  timestamps: false,
  allowNonNativeQueries: undefined,
  flatten: undefined
};

export class FirestoreConnectorModel<T> implements StrapiModel {

  readonly firestore: Firestore
  readonly options: Required<ModelOptions>
  readonly orm: 'firestore';
  readonly primaryKey: 'id';
  readonly primaryKeyType: 'string';
  readonly modelKey: string;
  
  readonly kind: 'collectionType' | 'singleType';

  readonly db: QueryableCollection<T>
  
  readonly assocKeys: string[];
  readonly componentKeys: string[];
  readonly defaultPopulate: string[];
  
  config: ModelConfig<FirebaseFirestore.DocumentData, any>;
  morphRelatedModels: Record<string, FirestoreConnectorModel<FirebaseFirestore.DocumentData>[]>;

  readonly connector: string;
  readonly connection: string;
  readonly attributes: Record<string, StrapiRelation>;
  readonly privateAttributes: Record<string, StrapiRelation>;
  readonly collectionName: string;
  readonly globalId: string;
  readonly modelName: string;
  readonly uid: string;
  readonly associations: StrapiAssociation[];


  private readonly singleKey : string | null;

  constructor(modelKey: string, connection: StrapiModel, firestore: Firestore, options: ConnectorOptions) {
    Object.assign(this, connection);

    this.firestore = firestore;

    
    this.orm = 'firestore'; 
    this.modelKey = modelKey;
    this.associations = [];

    this.options = {

    };

    this.singleKey = this.kind === 'singleType' ? this.options.singleId : null;

    const isComponent: boolean
    if (isComponent) {
      this.db = new QueryableComponentCollection(this);
    } else {
      if (this.options.flatten) {
        this.db = new QueryableFlatCollection(this, options);
      } else {
        this.db = new QueryableFirestoreCollection(this, options);
      }
    }
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

  async populate(data: Snapshot<T>, transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<T> {
    return await populateDoc(this, data, populate || this.defaultPopulate, transaction);
  }

  async populateAll(datas: Snapshot<T>[], transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<T[]> {
    return await populateDocs(this, datas, populate || this.defaultPopulate, transaction);
  }





  
    /**  
    */

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

}


export function mountModels(models: FirestoreConnectorContext[]) {

  function mountModel({ instance, isComponent, connection, modelKey, strapi, options }: FirestoreConnectorContext) {
    // @ts-expect-error
    const model: FirestoreConnectorModel = connection;
    model.collectionName = model.collectionName || model.globalId;

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
    model.defaultPopulate = model.associations
      .filter(ast => ast.autoPopulate !== false)
      .map(ast => ast.alias);

    // FIXME:
    // Correlate all models that relate to any polymorphic
    // relations in this model
    model.morphRelatedModels = {};
    
  }

  return models.forEach(mountModel);
}