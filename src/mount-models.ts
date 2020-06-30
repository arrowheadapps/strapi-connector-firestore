import * as _ from 'lodash';
import * as utils from 'strapi-utils';

import { FirestoreConnectorContext, StrapiModel, FirestoreConnectorModel } from './types';

export const DEFAULT_CREATE_TIME_KEY = 'createdAt';
export const DEFAULT_UPDATE_TIME_KEY = 'updatedAt';


export function mountModels(models: Record<string, StrapiModel>, target: Record<string, StrapiModel | FirestoreConnectorModel>, ctx: FirestoreConnectorContext) {

  function mountModel(modelKey: string) {
    const definition = models[modelKey];
    const collection = ctx.instance.collection(definition.collectionName || definition.globalId);
    definition.orm = 'firestore'; 
    definition.associations = [];

    // Set the default values to model settings.
    _.defaults(definition, {
      primaryKey: 'id',
      primaryKeyType: 'string',
    });

    // Use default timestamp column names if value is `true`
    if (_.get(definition, 'options.timestamps', false) === true) {
      _.set(definition, 'options.timestamps', [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY]);
    }
    // Use false for values other than `Boolean` or `Array`
    if (
      !_.isArray(_.get(definition, 'options.timestamps')) &&
      !_.isBoolean(_.get(definition, 'options.timestamps'))
    ) {
      _.set(definition, 'options.timestamps', false);
    }

    // Expose ORM functions through the `target` object.
    target[modelKey] = _.assign(
      collection, 
      target[modelKey],
      { _attributes: definition.attributes }
    );
    const model = target[modelKey] as FirestoreConnectorModel;


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
          const results = await ctx.strapi.query(modelKey).find({
            [`${field}_gte`]: value,
            [`${field}_lt`]: value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1) // Lexicographically increment the last character
          });
          return {
            toJSON: () => results
          }
        }
      }
    };

    const relationalAttributes = Object.keys(definition.attributes).filter(key => {
      const { type } = definition.attributes[key];
      return type === undefined;
    });

    // handle relational attrs
    relationalAttributes.forEach(name => {
      // Build associations key
      utils.models.defineAssociations(modelKey.toLowerCase(), definition, definition.attributes[name], name);
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
    
    const singleKey = model.kind === 'singleType' ? ctx.options.singleId : '';
    model.hasPK = (obj: any) => _.has(obj, model.primaryKey) || _.has(obj, 'id') || Boolean(singleKey);
    model.getPK = (obj: any) => singleKey || ((_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id));

    model.pickRelations = values => {
      return _.pick(values, model.assocKeys);
    };

    model.omitExernalValues = values => {
      return _.omit(values, model.excludedKeys);
    };


  }

  // Parse every authenticated model.
  Object.keys(models).map(mountModel);
};

