import * as _ from 'lodash';
import { allModels, FirestoreConnectorModel } from './model';
import type { StrapiModel, StrapiAttribute } from './types';
import type { Transaction } from './db/transaction';
import { RelationAttrInfo, RelationHandler, RelationInfo } from './utils/relation-handler';
import { doesComponentRequireMetadata } from './utils/components-indexing';
import type { Reference, SetOpts } from './db/reference';

export function shouldUpdateRelations(opts: SetOpts | undefined): boolean {
  return !opts || (opts.updateRelations !== false);
}


/**
 * Parse relation attributes on this updated model and update the referred-to
 * models accordingly.
 */
export async function relationsUpdate<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference<T>, prevData: T | undefined, newData: T | undefined, editMode: 'create' | 'update', transaction: Transaction) {
  await Promise.all(
    model.relations.map(r => r.update(ref, prevData, newData, editMode, transaction))
  );
}

export function buildRelations<T extends object>(model: FirestoreConnectorModel<T>, strapiInstance = strapi) {
  
  // Build the dominant relations (these exist as attributes on this model)
  // The non-dominant relations will be populated as a matter of course
  // when the other models are built
  for (const alias of Object.keys(model.attributes)) {
    const attr = model.attributes[alias];
    if (attr.isMeta) {
      continue;
    }

    const targetModelName = attr.model || attr.collection;
    if (!targetModelName) {
      // Not a relation attribute
      continue;
    }

    const isMorph = targetModelName === '*';
    const attrInfo = makeAttrInfo(alias, attr);
    const thisEnd: RelationInfo<any> = {
      model,
      parentModels: findParentModels(model, attrInfo, strapiInstance),
      attr: attrInfo,
    };

    let otherEnds: RelationInfo<any>[];
    if (isMorph) {
      otherEnds = findModelsRelatingTo(
        { model, attr, alias }, 
        strapiInstance
      );
    } else {
      const targetModel = strapiInstance.db.getModel(targetModelName, attr.plugin);
      if (!targetModel) {
        throw new Error(
          `Problem building relations. The model targetted by attribute "${alias}" ` +
          `on model "${model.uid}" does not exist.`
        );
      }
      const attrInfo = findOtherAttr(model, alias, attr, targetModel);
      otherEnds = [{
        model: targetModel,
        parentModels: findParentModels(model, attrInfo, strapiInstance),
        attr: attrInfo,
      }];
    }

    model.relations.push(new RelationHandler(thisEnd, otherEnds));

    // If there are any non-dominant other ends
    // Then we add them to the other model also
    // so that the other model knows about the relation
    // (I.e. This is necessary when that model is deleting itself)
    for (const other of otherEnds) {
      if (!other.attr) {
        other.model.relations = other.model.relations || [];
        other.model.relations.push(new RelationHandler(other, [thisEnd]));
      }
    }
  }
}



function findModelsRelatingTo(info: { model: FirestoreConnectorModel<any>, attr: StrapiAttribute, alias: string }, strapiInstance = strapi): RelationInfo<any>[] {
  const related: RelationInfo<any>[] = [];
  for (const { model } of allModels(strapiInstance)) {
    if (model.isComponent) {
      // Dominant relations to components not supported
      // Quietly ignore this on polymorphic relations because it
      // isn't specifically directed to this component model
      continue;
    }
    
    for (const alias of Object.keys(model.attributes)) {
      const attr = model.attributes[alias];
      const otherModelName = attr.model || attr.collection;
      if (otherModelName
        && (otherModelName === info.model.modelName)
        && ((attr.via === info.alias) || (info.attr.via === alias))) {
        const attrInfo = makeAttrInfo(alias, attr);
        related.push({
          model: model,
          parentModels: findParentModels(model, attrInfo, strapiInstance),
          attr: attrInfo,
        });
      }
    }
  }
  return related;
}

function findOtherAttr(thisModel: StrapiModel<any>, key: string, attr: StrapiAttribute, otherModel: StrapiModel<any>): RelationAttrInfo | undefined {
  const alias = Object.keys(otherModel.attributes).find(alias => {
    const otherAttr = otherModel.attributes[alias];
    if ((otherAttr.model || otherAttr.collection) === thisModel.modelName) {
      if (attr.via && (attr.via === alias)) {
        return true;
      }
      if (otherAttr.via && (otherAttr.via === key)) {
        return true;
      }
    }
    return false;
  });

  if (alias) {
    const otherAttr = otherModel.attributes[alias];
    return makeAttrInfo(alias, otherAttr);
  }
  return undefined;
}

function findParentModels<T extends object>(componentModel: FirestoreConnectorModel<T>, componentAttr: RelationAttrInfo | undefined, strapiInstance = strapi): RelationInfo<T>[] | undefined {
  const relations: RelationInfo<T>[] = [];
  if (componentModel.isComponent && componentAttr) {
    const indexer = (componentModel.indexers || []).find(info => info.alias === componentAttr.alias);
    if (!indexer || !indexer.defaultIndexer) {
      // This should not be able to happen because it is guaranteed by buildIndexers()
      throw new Error('Relation in component does not have a default indexer');
    }

    for (const { model: otherModel } of allModels(strapiInstance)) {
      if (componentModel.uid !== otherModel.uid) {
        for (const alias of Object.keys(otherModel.attributes)) {
          const attr = otherModel.attributes[alias];
          if ((attr.component === componentModel.uid)
             || (attr.components && attr.components.includes(componentModel.uid))) {
            const isRepeatable = doesComponentRequireMetadata(attr);
            relations.push({
              model: otherModel,
              attr: componentAttr ? {
                ...componentAttr,
                isMeta: isRepeatable,
                actualAlias: {
                  componentAlias: componentAttr.alias,
                  parentAlias: alias,
                },
                alias: isRepeatable 
                  ? `${otherModel.getMetadataMapKey(alias)}.${indexer.defaultIndexer}`
                  : `${alias}.${componentAttr.alias}`,
              } : undefined,
              parentModels: undefined,
            });
          }
        }
      }
    }
  }
  return relations.length ? relations : undefined;
}

function makeAttrInfo(alias: string, attr: StrapiAttribute): RelationAttrInfo {
  return {
    alias,
    isArray: !attr.model || Boolean(attr.collection) || attr.repeatable || (attr.type === 'dynamiczone'),
    isMorph: (attr.model || attr.collection) === '*',
    filter: attr.filter,
    actualAlias: undefined,
    isMeta: false,
  };
}
