import * as _ from 'lodash';
import { FieldValue, DocumentReference, DocumentData } from '@google-cloud/firestore';;
import type { FirestoreConnectorModel, StrapiAssociation } from './types';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference } from './utils/queryable-collection';
import { DeepReference } from './utils/deep-reference';
import { coerceReference, coerceToReferenceSingle } from './utils/coerce';



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

    const setReverse = (assocRef: Reference, set: boolean) => {
      const reverseValue = set
        ? (reverseAssoc.collection ? FieldValue.arrayUnion(ref) : ref)
        : (reverseAssoc.collection ? FieldValue.arrayRemove(ref) : null);

      promises.push(
        assocModel.update(assocRef, { [assoc.via]: reverseValue }, transaction),
      );
    }

    const findAndRemoveThis = () => {
      const q = reverseAssoc.model
        ? assocModel.db.where(assoc.alias, '==', ref)
        : assocModel.db.where(assoc.alias, 'array-contains', ref);

      promises.push(
        transaction.get(q).then(snap => {
          snap.docs.forEach(d => {
            setReverse(d.ref, false);
          });
        })
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
          _.set(newData, assoc.alias, newValue);
        } else {
          _.unset(newData, assoc.alias);
        }
      }

      if (reverseAssoc.dominant) {
        // Reference to this model is stored in the associated document
        
        if (assoc.dominant) {
          // This association is also dominant so we can rely on it to 
          // find the associated documents

          // Assign this reference to new associations
          added.forEach(assocRef => setReverse(assocRef, true));

          // Remove this reference from old associations
          removed.forEach(assocRef =>  setReverse(assocRef, false));

        } else {
          // We need to search to find the associated documents
          findAndRemoveThis();
        }

      }

      return;
    }

    if (assoc.model) {
      const prevValue = valueAsSingle(prevData, assoc, assocModel, true);
      const newValue = valueAsSingle(newData, assoc, assocModel, true);

      if (newData) {
        if (assoc.dominant) {
          // Reference to associated model is stored in this document
          _.set(newData, assoc.alias, newValue);
        } else {
          _.unset(newData, assoc.alias);
        }
      }

      if (reverseAssoc.dominant && !refEquals(prevValue, newValue)) {
        // Reference to this model is stored in the associated document

        if (assoc.dominant) {
          // This association is also dominant so we can rely on it to 
          // find the associated documents

          // Assign this reference to the new association
          if (newValue) {
            setReverse(newValue, true);
          }

          // Remove this reference from the old association
          if (prevValue) {
            setReverse(prevValue, false);
          }

        } else {
          // We need to search to find the associated documents
          findAndRemoveThis();
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











interface MorphReference<S = 'field'> {
  ref: Reference
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

function valueAsArray(data: DocumentData | undefined, { alias, nature }: StrapiAssociation, assocModel: FirestoreConnectorModel, strict: boolean): Reference[] | undefined {
  if (data) {
    const value = coerceReference(data[alias] || [], assocModel, strict);
    if (!Array.isArray(value)) {
      throw new Error(`Value of ${nature} association must be an array.`);
    }
    return value;
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
  