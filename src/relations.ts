import * as _ from 'lodash';
import * as utils from 'strapi-utils';
import { allModels, FirestoreConnectorModel } from './model';
import type { StrapiModel, StrapiAttribute } from './types';
import type { Reference } from './utils/queryable-collection';
import type { Transaction } from './utils/transaction';
import { RelationAttrInfo, RelationHandler, RelationInfo } from './utils/relation-handler';
import { componentRequiresMetadata } from './utils/components';


/**
 * Parse relation attributes on this updated model and update the referred-to
 * models accordingly.
 */
export async function relationsUpdate<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference<T>, prevData: T | undefined, newData: T | undefined, transaction: Transaction) {
  await Promise.all(
    model.relations.map(r => r.update(ref, prevData, newData, transaction))
  );
}

/**
 * When this model is being deleted, parse and update the referred-to models accordingly.
 */
export async function relationsDelete<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference<T>, prevData: T, transaction: Transaction) {
  await relationsUpdate(model, ref, prevData, undefined, transaction); 
}

/**
 * When this model is being creted, parse and update the referred-to models accordingly.
 */
export async function relationsCreate<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference<T>, newData: T, transaction: Transaction) {
  await relationsUpdate(model, ref, undefined, newData, transaction); 
}


export function buildRelations<T extends object>(model: FirestoreConnectorModel<T>, strapiInstance = strapi) {
  
  model.relations = model.relations || [];

  // Build the dominant relations (these exist as attributes on this model)
  // The non-dominant relations will be populated as a matter of course
  // when the other models are built
  Object.keys(model.attributes).forEach(alias => {
    const attr = model.attributes[alias];

    // Required for other parts of Strapi to work
    utils.models.defineAssociations(model.uid.toLowerCase(), model, attr, alias);

    const targetModelName = attr.model || attr.collection;
    if (!targetModelName) {
      // Not a relation attribute
      return;
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
    otherEnds.forEach(other => {
      if (!other.attr) {
        other.model.relations = other.model.relations || [];
        other.model.relations.push(new RelationHandler(other, [thisEnd]));
      }
    });
  });
}



function findModelsRelatingTo(info: { model: FirestoreConnectorModel<any>, attr: StrapiAttribute, alias: string }, strapiInstance = strapi): RelationInfo<any>[] {
  const related: RelationInfo<any>[] = [];
  for (const model of allModels(strapiInstance)) {
    Object.keys(model.attributes)
      .forEach(alias => {
        const attr = model.attributes[alias];
        const otherModelName = attr.model || attr.collection;
        if (otherModelName
          && (otherModelName === info.model.modelName)
          && ((attr.via === info.alias) || (info.attr.via === alias))) {
          const attrInfo = makeAttrInfo(alias, attr);
          related.push({
            model: model as FirestoreConnectorModel<any>,
            parentModels: findParentModels(model, attrInfo, strapiInstance),
            attr: attrInfo,
          });
        }
      });
  }
  return related;
}

function findOtherAttr(thisModel: StrapiModel, key: string, attr: StrapiAttribute, otherModel: StrapiModel): RelationAttrInfo | undefined {
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
  if (componentModel.isComponent) {
    for (const otherModel of allModels(strapiInstance)) {
      if (componentModel.uid !== otherModel.uid) {
        Object.keys(otherModel.attributes).forEach(alias => {
          const attr = otherModel.attributes[alias];
          if ((attr.component === componentModel.uid)
             || (attr.components && attr.components.includes(componentModel.uid))) {
            const isRepeatable = componentRequiresMetadata(attr);
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
                  ? [otherModel.getMetadataField(alias), componentAttr.alias].join('.')
                  : [alias, componentAttr.alias].join('.'),
              } : undefined,
              parentModels: undefined,
            });
          }
        });
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
