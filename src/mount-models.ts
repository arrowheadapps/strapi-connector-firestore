import * as _ from 'lodash';
import * as utils from 'strapi-utils';

import { FirestoreConnectorContext, StrapiModel, FirestoreConnectorModel } from './types';

export function mountModels(models: Record<string, StrapiModel>, target: Record<string, StrapiModel | FirestoreConnectorModel>, ctx: FirestoreConnectorContext) {

  function mountModel(modelKey: string) {
    const definition = models[modelKey];
    const collection = ctx.instance.collection(definition.collectionName || definition.globalId);

    // We need to emulate the bookshelf query behaviour 
    // because strapi has hard-coded behaviour
    // See: strapi-plugin-content-manager/services/utils/store.js L53
    definition.orm = 'firestore'; 


    // Set the default values to model settings.
    _.defaults(definition, {
      primaryKey: '_id',
      primaryKeyType: 'string',
    });

    // Use default timestamp column names if value is `true`
    if (_.get(definition, 'options.timestamps', false) === true) {
      _.set(definition, 'options.timestamps', ['_createTime', '_updateTime']);
    }
    // Use false for values other than `Boolean` or `Array`
    if (
      !_.isArray(_.get(definition, 'options.timestamps')) &&
      !_.isBoolean(_.get(definition, 'options.timestamps'))
    ) {
      _.set(definition, 'options.timestamps', false);
    }

    // TODO
    // ORM lifecycle hooks


    // Expose ORM functions through the `target` object.
    target[modelKey] = _.assign(
      collection, 
      target[modelKey],
      { _attributes: definition.attributes, associations: [] }
    );


    // HACK:
    // For strapi-plugin-content-manager which accesses 
    // the raw ORM layer and only knows about mongoose and bookshelf connectors
    // See: strapi-plugin-content-manager/services/utils/store.js L53

    /**
      return model
        .query(qb => {
          qb.where('key', 'like', `${key}%`);
        })
        .fetchAll()
        .then(config => config && config.toJSON())
        .then(results => results.map(({ value }) => JSON.parse(value)));  
     */

    // It seems that the aim here is to emulate searching for a prefix
    // in the key field
    // @ts-ignore
    target[modelKey].query = (init) => {
      let field!: string, value!: string;
      const qb = {
        where: (f: string, op: string, v: string) => {
          if (op !== 'like') {
            throw new Error('Not implemented!');
          }
          field = f;
          value = v;
        }
      };
      init(qb);


      if (value.endsWith('%')) {
        value = value.slice(0, -1);
      }

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
  }

  // Parse every authenticated model.
  Object.keys(models).map(mountModel);
};

