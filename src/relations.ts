import * as _ from 'lodash';
import { allModels, FirestoreConnectorModel } from './model';
import type { StrapiModel, StrapiAttribute } from './types';
import type { Reference } from './utils/queryable-collection';
import type { Transaction } from './utils/transaction';
import { RelationAttrInfo, RelationHandler, RelationInfo } from './utils/relation-handler';


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
  
  model.relations = [];

  // Build the dominant relations (these exist as attributes on this model)
  // The non-dominant relations will be populated as a matter of course
  // when the other models are built
  Object.keys(model.attributes).forEach(alias => {
    const attr = model.attributes[alias];
    const targetModelName = attr.model! || attr.collection!;
    const isMorph = targetModelName === '*';
    const thisEnd: RelationInfo<any> = {
      model,
      attr: {
        alias,
        isArray: !attr.model,
        isMorph,
        filter: attr.filter,
      },
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
      otherEnds = [{
        model: targetModel,
        attr: findOtherAttr(alias, attr, targetModel),
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
        if ((otherModelName === info.model.modelName)
          && ((attr.via === info.alias) || (info.attr.via === alias))) {
          related.push({
            model: model as FirestoreConnectorModel<any>,
            attr: {
              alias,
              isArray: !attr.model,
              isMorph: false,
              filter: attr.filter,
            },
          });
        }
      });
  }
  return related;
}

function findOtherAttr(key: string, attr: StrapiAttribute, otherModel: StrapiModel): RelationAttrInfo | undefined {
  const alias = Object.keys(otherModel.attributes).find(alias => {
    if (attr.via && (attr.via === alias)) {
      return true;
    }
    const otherAttr = otherModel.attributes[alias];
    if (otherAttr.via && (otherAttr.via === key)) {
      return true;
    }
    return false;
  });

  if (alias) {
    const otherAttr = otherModel.attributes[alias];
    return {
      alias,
      isArray: !otherAttr.model,
      isMorph: (otherAttr.model || otherAttr.collection) === '*',
      filter: otherAttr.filter,
    };
  }
  return undefined;
}
