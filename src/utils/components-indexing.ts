import * as _ from 'lodash';
import type { FirestoreConnectorModel } from '../model';
import type { IndexerFn, StrapiAttribute, StrapiModel } from '../types';
import { toFirestore } from './coerce';
import { getComponentModel } from './components';
import { isEqualHandlingRef } from './queryable-collection';



export function doesComponentRequireMetadata(attr: StrapiAttribute): boolean {
  return (attr.type === 'dynamiczone') 
    || ((attr.type === 'component') && (attr.repeatable === true));
}

export function updateComponentsMetadata<T extends object>(model: FirestoreConnectorModel<T>, data: T, output: T = data) {
  for (const parentAlias of model.componentKeys) {

    // Don't overwrite metadata with empty map if the value 
    // doesn't exist because this could be a partial update
    if (!_.has(data, parentAlias)) {
      continue;
    }

    const parentAttr = model.attributes[parentAlias];
    if (doesComponentRequireMetadata(parentAttr)) {
      const metaField = model.getMetadataMapKey(parentAlias);

      // Initialise the map will null for all known keys
      const meta: { [key: string]: any[] | null } = {};
      const componentModels = parentAttr.component ? [parentAttr.component] : (parentAttr.components || []);
      for (const modelName of componentModels) {
        const { indexers = [] } = getComponentModel(modelName);
        for (const info of indexers) {
          for (const key of Object.keys(info.indexers)) {
            meta[key] = null;
          }
        }
      }

      // Make an array containing the value of this attribute from all the components in the array
      // If the value itself is an array then is is concatenated/flattened
      const components: any[] = _.castArray(_.get(data, parentAlias) || []);
      for (const component of components) {
        const componentModel = getComponentModel(model, parentAlias, component);
        if (!componentModel.indexers) {
          continue;
        }

        for (const { alias, attr, indexers } of componentModel.indexers) {
          const values = _.castArray(_.get(component, alias, []));

          for (const key of Object.keys(indexers)) {
            const arr = meta[key] = meta[key] || [];
            const indexer = indexers[key];

            for (let value of values) {
              // FIXME: Coercion will not be required when coercion lifecycle is fixed
              value = toFirestore(attr, value);
              const result = indexer(value, component);

              // Only add if the element doesn't already exist
              // and is not undefined
              if ((result !== undefined)
                && (!arr.some(v => isEqualHandlingRef(v, result)))) {
                arr.push(result);
              }
            }
          }
        }
      }

      // Ensure all empty indexes are null
      for (const key of Object.keys(meta)) {
        const arr = meta[key];
        if (!arr || !arr.length) {
          meta[key] = null;
        }
      }

      _.set(output, metaField, meta);
    }
  }
}



export interface AttributeIndexInfo {
  alias: string
  attr: StrapiAttribute
  defaultIndexer?: string
  indexers: {
    [key: string]: IndexerFn
  }
}

/**
 * Build indexers for all the indexed attributes
 * in a component model.
 */
export function buildIndexers<T extends object>(model: StrapiModel<T>): AttributeIndexInfo[] | undefined {
  if (model.modelType !== 'component') {
    return undefined;
  }

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

      // Delete index info from the original attribute definition
      // no longer needed and it clutters API metadata etc
      delete attr.index;

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
