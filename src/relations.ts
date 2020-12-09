import * as _ from 'lodash';
import { FieldValue, DocumentReference, DocumentData } from '@google-cloud/firestore';;
import type { FirestoreConnectorModel, StrapiAssociation } from './types';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference } from './utils/queryable-collection';
import { DeepReference } from './utils/deep-reference';
import { coerceReference, coerceToReferenceSingle } from './utils/coerce';

function valueAsArray(data: DocumentData | undefined, { alias, nature }: StrapiAssociation, assocModel: FirestoreConnectorModel, strict: boolean): Reference[] | undefined {
  if (data) {
    const value = data[alias] || [];
    if (!Array.isArray(value)) {
      throw new Error(`Value of ${nature} association must be an array.`);
    }
    
    const refs = new Array<Reference>(value.length);
    value.forEach(v => {
      const ref = coerceToReferenceSingle(v, assocModel, true);
      if (ref) {
        refs.push(ref);
      } else if (strict) {
        throw new Error(`Array of ${nature} associations cannot contain an empty value`);
      }
    });
    return refs;

  } else {
    return undefined;
  }
}

function valueAsSingle(data: DocumentData | undefined, { alias, nature }: StrapiAssociation, assocModel: FirestoreConnectorModel, strict: boolean): Reference | null | undefined {
  if (data) {
    const value = data[alias] || null;
    if (Array.isArray(value)) {
      throw new Error(`Value of ${nature} association must not be an array.`);
    }
    return coerceToReferenceSingle(value, assocModel, true);
  } else {
    return undefined;
  }
}


/**
 * Parse relation attributes on this updated model and update the referred-to
 * models accordingly.
 */
export async function relationsUpdate(model: FirestoreConnectorModel, ref: Reference, prevData: DocumentData | undefined, newData: DocumentData | undefined, transaction: TransactionWrapper) {
  const promises: Promise<any>[] = [];

  model.associations.forEach(assoc => {

    const assocModel = strapi.db.getModelByAssoc(assoc);
    if (!assocModel) {
      if ((assoc.collection || assoc.model) === '*') {
        // TODO:
        // How to handle polymorphic relations?
        return;
      } else {
        throw new Error(`Associated model "${assoc.collection || assoc.model}" not found.`);
      }
    }

    const reverseAssoc = assocModel.associations.find(a => a.alias === assoc.via);
    if (!reverseAssoc) {
      throw new Error(`Related attribute "${assoc.via}" on the associated model "${assocModel.globalId}" not found.`);
    }

    const setReverse = (assocRef: Reference, value: any) => {
      promises.push(
        assocModel.setMerge(
          assocRef, 
          {
            [assoc.via]: value
          },
          transaction,
        )
      );
    }

    if (assoc.collection) {
      const prevValue = valueAsArray(prevData, assoc, assocModel, true);
      const newValue = valueAsArray(newData, assoc, assocModel, true);

      const removed = _.differenceWith(prevValue, newValue || [], refEquals);
      const added = _.differenceWith(newValue, prevValue || [], refEquals)

      if (newData) {
        if (assoc.dominant) {
          // Reference to associated model is stored in this document
          newData[assoc.alias] = newValue;
        } else {
          delete newData[assoc.alias];
        }
      }

      if (reverseAssoc.dominant) {
        // Reference to this model is stored in the associated document
        
        // Assign this reference to new associations
        added.forEach(assocRef => {
          const reverseNewValue = reverseAssoc.collection
            ? FieldValue.arrayUnion(ref)
            : ref;
          setReverse(assocRef, reverseNewValue);
        });

        // Remove this reference from old associations
        removed.forEach(assocRef => {
          const reverseNewValue = reverseAssoc.collection
            ? FieldValue.arrayRemove(ref)
            : null;
          setReverse(assocRef, reverseNewValue);
        });

      }

      return;
    }

    if (assoc.model) {
      const prevValue = valueAsSingle(prevData, assoc, assocModel, true);
      const newValue = valueAsSingle(newData, assoc, assocModel, true);

      if (newData) {
        if (assoc.dominant) {
          // Reference to associated model is stored in this document
          newData[assoc.alias] = newValue;
        } else {
          delete newData[assoc.alias];
        }
      }

      if (reverseAssoc.dominant && !refEquals(prevValue, newValue)) {
        // Reference to this model is stored in the associated document

        // Assign this reference to the new association
        if (newValue) {
          const reverseNewValue = reverseAssoc.collection
              ? FieldValue.arrayUnion(ref)
              : ref;
          setReverse(newValue, reverseNewValue);
        }

        // Remove this reference from the old association
        if (prevValue) {
          const reverseNewValue = reverseAssoc.collection
            ? FieldValue.arrayRemove(ref)
            : null;
          setReverse(prevValue, reverseNewValue);
        }
      }

      return;
    }

    throw new Error('Unexpected type of association. Expected `collection` or `model` to be defined.')
  });

  await Promise.all(promises);
}

/**
 * When this model is being deleted, parse and update the referred-to models
 * accordingly.
 */
export async function relationsDelete(model: FirestoreConnectorModel, ref: Reference, prevData: DocumentData, transaction: TransactionWrapper) {
  await relationsUpdate(model, ref, prevData, undefined, transaction); 
}













interface MorphDef {
  id?: Reference
  alias: string
  refId: Reference
  ref: string
  field: string
  filter: string
}

function refEquals(a: Reference | null | undefined, b: Reference | null | undefined): boolean {
  if (a == b) {
    // I.e. both are `null` or `undefined`, or
    // the exact same instance
    return true;
  }
  if (a instanceof DocumentReference) {
    return a.isEqual(b as any);
  }
  if (a instanceof DeepReference) {
    return a.isEqual(b as any);
  }
  return false;
}

const removeUndefinedKeys = (obj: any) => _.pickBy(obj, _.negate(_.isUndefined));

const addRelationMorph = async (model: FirestoreConnectorModel, params: MorphDef, transaction: TransactionWrapper) => {
  const { id, alias, refId, ref, field, filter } = params;

  await model.setMerge(
    id!, 
    {
      [alias]: FieldValue.arrayUnion({
        ref: refId,
        kind: ref,
        [filter]: field,
      })
    },
    transaction
  );
};

const removeRelationMorph = async (model: FirestoreConnectorModel, params: MorphDef, transaction: TransactionWrapper) => {
  const { id, alias, filter, field, ref, refId } = params;

  const value = {
    [alias]: FieldValue.arrayRemove({
      ref: refId,
      kind: ref,
      [filter]: field,
    }),
  };

  if (id) {
    await model.setMerge(id, value, transaction);

  } else {

    const q = model.db.where(alias, 'array-contains', value);
    const docs = (await (transaction ? transaction.get(q) : q.get())).docs;
    await Promise.all(docs.map(d => model.setMerge(d.ref, value, transaction)));
  }
};


export async function _updateRelations(model: FirestoreConnectorModel, params: { data, values, ref: Reference }, transaction: TransactionWrapper) {

  const { data, ref, values } = params;
  const relationUpdates: Promise<any>[] = [];

  // Only update fields which are on this document.
  Object.keys(removeUndefinedKeys(values)).forEach((attribute) => {
    const details = model.attributes[attribute];
    const association = model.associations.find(x => x.alias === attribute)!;

    const assocModel = strapi.db.getModelByAssoc(details);
    if (!assocModel) {
      throw new Error('Associated model no longer exists');
    }

    const currentRef = coerceReference(data[attribute], assocModel);
    const newRef = coerceReference(values[attribute], assocModel);

    switch (association.nature) {
      case 'oneWay': {
        if (_.isArray(newRef)) {
          throw new Error('oneWay relation cannot be an array');
        }
        return _.set(data, attribute, newRef);
      }

      case 'oneToOne': {
        if (_.isArray(currentRef) || _.isArray(newRef)) {
          throw new Error('oneToOne relation cannot be an array');
        }

        // if value is the same don't do anything
        if (refEquals(newRef, currentRef)) return;

        // if the value is null, set field to null on both sides
        if (!newRef) {
          if (currentRef) {
            relationUpdates.push(assocModel.setMerge(currentRef, { [details.via]: null }, transaction));
          }
          return _.set(data, attribute, null);
        }

        // set old relations to null
        relationUpdates.push(transaction.get(newRef).then(async snap => {
          const d = snap.data();
          if (d && d[details.via]) {
            const oldLink = coerceReference(d[details.via], assocModel);
            if (oldLink) {
              await assocModel.setMerge(oldLink as DocumentReference, { [attribute]: null }, transaction);
            }
          }

          // set new relation
          await assocModel.setMerge(newRef, { [details.via]: ref }, transaction);

        }));
        return _.set(data, attribute, newRef);
      }

      case 'oneToMany': {
        // set relation to null for all the ids not in the list
        const currentArray = currentRef ? _.castArray(currentRef): [];
        const newArray = newRef ? _.castArray(newRef) : [];
        const toRemove = _.differenceWith(currentArray, newArray, refEquals);
        
        toRemove.forEach(r => {
          relationUpdates.push(assocModel.setMerge(r, { [details.via]: null }, transaction));
        });
        newArray.map(r => {
          relationUpdates.push(assocModel.setMerge(r, { [details.via]: ref }, transaction));
        });
        
        return;
      }
      
      case 'manyToOne': {
        return _.set(data, attribute, newRef);
      }

      case 'manyWay':
      case 'manyToMany': {
        if ((currentRef && !_.isArray(currentRef)) || (newRef && !_.isArray(newRef))) {
          throw new Error('manyToMany relation must be an array');
        }
        if (association.dominant) {
          return _.set(data, attribute, newRef);
        }

        ((currentRef as Reference[]) || []).map(v => {
          relationUpdates.push(assocModel.setMerge(v, { [association.via]: FieldValue.arrayRemove(ref) }, transaction));
        });
        ((newRef as Reference[]) || []).map(v => {
          relationUpdates.push(assocModel.setMerge(v, { [association.via]: FieldValue.arrayUnion(ref) }, transaction));
        });

        return;
      }

      // media -> model
      case 'manyMorphToMany':
      case 'manyMorphToOne': {

        const newValue = values[attribute];
        if (newValue && !_.isArray(newValue)) {
          throw new Error('manyMorphToMany or manyMorphToOne relation must be an array');
        }

        relationUpdates.push(Promise.all((newValue || []).map(async obj => {
          const refModel = strapi.getModel(obj.ref, obj.source);

          const createRelation = () => {
            return addRelationMorph(assocModel, {
              id: ref,
              alias: association.alias,
              ref: obj.kind || refModel.globalId,
              refId: model.doc(obj.refId),
              field: obj.field,
              filter: association.filter,
            }, transaction);
          };

          // Clear relations to refModel
          const reverseAssoc = refModel.associations.find(assoc => assoc.alias === obj.field);
          if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
            await removeRelationMorph(assocModel, {
              alias: association.alias,
              ref: obj.kind || refModel.globalId,
              refId: model.doc(obj.refId),
              field: obj.field,
              filter: association.filter,
            }, transaction);
            await createRelation();
            await assocModel.setMerge(refModel.doc(obj.refId), {
              [obj.field]: ref
            }, transaction);
          } else {
            createRelation();
            await assocModel.setMerge(refModel.doc(obj.refId), FieldValue.arrayUnion(ref), transaction);
          }
        })));
        break;
      }

      // model -> media
      case 'oneToManyMorph':
      case 'manyToManyMorph': {
        const newIds = newRef ? _.castArray(newRef) : [];
        const currentIds = currentRef ? _.castArray(currentRef) : [];

        // Compare array of ID to find deleted files.
        const toAdd = _.differenceWith(newIds, currentIds, refEquals);
        const toRemove = _.differenceWith(currentIds, currentIds, refEquals);

        const morphModel = strapi.db.getModelByAssoc(details);

        _.set(data, attribute, newIds);

        toRemove.forEach(id => {
          relationUpdates.push(removeRelationMorph(morphModel!, {
            id,
            alias: association.via,
            ref: model.globalId,
            refId: ref,
            field: association.alias,
            filter: association.filter,
          }, transaction));
        });

        toAdd.forEach(id => {
          relationUpdates.push(addRelationMorph(morphModel!, {
            id,
            alias: association.via,
            ref: model.globalId,
            refId: ref,
            field: association.alias,
            filter: association.filter,
          }, transaction));
        });

        break;
      }
      case 'oneMorphToOne':
      case 'oneMorphToMany':
        break;
      default:
    }
  });

  await Promise.all(relationUpdates);
}

export async function _deleteRelations(model: FirestoreConnectorModel, params: { entry: any, ref: Reference}, transaction: TransactionWrapper) {
  const { entry, ref } = params;

  // Update oneWay and manyWay relations from other models
  // that point to this entry which is being deleted
  // This entry has no link to those relations so we have
  // to search for them manually
  const relatedAssocAsync = Promise.all(
    model.relatedNonDominantAttrs.map(async ({ key, attr, modelKey }) => {
      const relatedModel = strapi.db.getModelByGlobalId(modelKey);
      if (!relatedModel) {
        // Silently ignore non-existent models
        return;
      }
      const q = attr.model
        ? relatedModel.db.where(key, '==', ref)
        : relatedModel.db.where(key, 'array-contains', ref);
      const docs = (await transaction.get(q)).docs;
      await Promise.all(docs.map(async d => {
        if (attr.model) {
          await relatedModel.setMerge(d.ref, { [key]: null }, transaction);
        } else {
          await relatedModel.setMerge(d.ref, { [key]: FieldValue.arrayRemove(ref) }, transaction);
        }
      }));
    })
  );

  // Update the relations that point to this entry which
  // is being deleted
  const assocAsync = Promise.all(
    model.associations.map(async association => {
      const { nature, via, dominant, alias } = association;
      const details = model.attributes[alias];
  
      const assocModel = strapi.db.getModelByAssoc(details);
      if (!assocModel) {
        throw new Error('Associated model no longer exists');
      }
      const currentValue = coerceReference(entry[alias], assocModel);

      // TODO: delete all the ref to the model

      switch (nature) {
        case 'oneWay':
        case 'manyWay': {
          return;
        }

        case 'oneToMany':
        case 'oneToOne': {
          if (!via || !currentValue) {
            return;
          }
          if (_.isArray(currentValue)) {
            throw new Error('oneToMany or oneToOne relation must not be an array');
          }
          await assocModel.setMerge(currentValue, { [via]: null }, transaction);
          return;
        }

        case 'manyToMany':
        case 'manyToOne': {
          if (!via || dominant || !currentValue) {
            return;
          }
          if (_.isArray(currentValue)) {
            await Promise.all(currentValue.map(async v => {
              await assocModel.setMerge(v, { [via]: FieldValue.arrayRemove(ref) }, transaction);
            }));
          } else {
            await assocModel.setMerge(currentValue, { [via]: FieldValue.arrayRemove(ref) }, transaction);
          }
          return;
        }

        case 'oneToManyMorph':
        case 'manyToManyMorph': {
          // delete relation inside of the ref model
          const targetModel = strapi.db.getModelByAssoc(details);

          // ignore them ghost relations
          if (!targetModel) return;

          const element = {
            ref,
            kind: model.globalId,
            [association.filter]: association.alias,
          };

          await assocModel.setMerge(ref, { [via]: FieldValue.arrayRemove(element) }, transaction);
          return;
        }

        case 'manyMorphToMany':
        case 'manyMorphToOne': {
          // delete relation inside of the ref model

          if (Array.isArray(entry[association.alias])) {
            return Promise.all(
              entry[association.alias].map(async val => {
                const targetModel = strapi.db.getModelByGlobalId(val.kind);

                // ignore them ghost relations
                if (!targetModel) return;

                const field = val[association.filter];
                const reverseAssoc = targetModel.associations.find(
                  assoc => assoc.alias === field
                );

                const q = targetModel.db.where(targetModel.primaryKey, '==', val.ref && (val.ref._id || val.ref));
                const docs = (await transaction.get(q)).docs;

                if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
                  await Promise.all(docs.map(async d => {
                    await assocModel.setMerge(d.ref, { [field]: null }, transaction);
                  }));
                } else {
                  await Promise.all(docs.map(async d => {
                    await assocModel.setMerge(d.ref, { [field]: FieldValue.arrayRemove(ref) }, transaction);
                  }));
                }
              })
            );
          }

          return;
        }

        case 'oneMorphToOne':
        case 'oneMorphToMany': {
          return;
        }

        default:
          return;
      }
    })
  );

  await Promise.all([assocAsync, relatedAssocAsync]);
}
  