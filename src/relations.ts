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

    const reverse = getReverseAssocByAssoc(assoc);

    const setReverse = (r: ReverseAssocDetails, assocRef: Reference, set: boolean) => {
      // Store a plain reference for normal relations
      // but an object with extra info for polymorphic relations
      const refValue = reverse
        ? ref
        : { ref, [r.assoc.filter]: assoc.alias };

      const reverseValue = set
        ? (r.assoc.collection ? FieldValue.arrayUnion(refValue) : refValue)
        : (r.assoc.collection ? FieldValue.arrayRemove(refValue) : null);

      promises.push(
        r.model.update(assocRef, { [r.assoc.alias]: reverseValue }, transaction),
      );
    };

    const findAndSetThis = (added: Reference[], removed: Reference[]) => {
      if (reverse) {
        if (reverse.assoc.dominant) {
          // Assign this reference to new values
          added.forEach(assocRef => setReverse(reverse, assocRef, true));

          // Remove this reference from old values
          if (assoc.dominant) {
            // Previous references were stored in this document
            // so we can find them directly
            removed.forEach(assocRef => setReverse(reverse, assocRef, false));
          } else {
            // Previous references were not stored in this document
            // so we need to search for them
            const q = reverse.assoc.model
              ? reverse.model.db.where(assoc.alias, '==', ref)
              : reverse.model.db.where(assoc.alias, 'array-contains', ref);

            promises.push(
              transaction.get(q).then(snap => {
                snap.docs.forEach(d => {
                  setReverse(reverse, d.ref, false);
                });
              })
            );
          }

        } else {
          // I.e. reverse.assoc.dominant == false
          // Other association is not dominant
          // so there is no storage on the other end
        }

      } else {
        // Handle polymorphic relation

        added.forEach(morphRef => {
          const morphReverse = getReverseAssocByModel(getModelByRef(morphRef), assoc);
          if (morphReverse.assoc.dominant) {
            setReverse(morphReverse, morphRef, true);
          }
        });

        if (assoc.dominant) {
          removed.forEach(morphRef => {
            const morphReverse = getReverseAssocByModel(getModelByRef(morphRef), assoc);
            if (morphReverse.assoc.dominant) {
              setReverse(morphReverse, morphRef, false);
            }
          });
        } else {
          // TODO:
          // We need to search the collections of all models
          // that are related to this polymorphic relation
          strapi.log.warn('Polymorphic relations not implemented');
        }
      }
    };

    if (assoc.collection) {
      const prevValue = valueAsArray(prevData, assoc, reverse, true);
      const newValue = valueAsArray(newData, assoc, reverse, true);

      if (newData) {
        if (assoc.dominant) {
          // Reference to associated model is stored in this document
          _.set(newData, assoc.alias, newValue);
        } else {
          _.unset(newData, assoc.alias);
        }
      }

      const removed = _.differenceWith(prevValue, newValue || [], refEquals);
      const added = _.differenceWith(newValue, prevValue || [], refEquals)
      findAndSetThis(added, removed);

      return;
    }

    if (assoc.model) {
      const prevValue = valueAsSingle(prevData, assoc, reverse, true);
      const newValue = valueAsSingle(newData, assoc, reverse, true);

      if (newData) {
        if (assoc.dominant) {
          // Reference to associated model is stored in this document
          _.set(newData, assoc.alias, newValue);
        } else {
          _.unset(newData, assoc.alias);
        }
      }

      const added = newValue ? [newValue] : [];
      const removed = prevValue ? [prevValue] : [];
      findAndSetThis(added, removed);

      return;
    }

    throw new Error('Unexpected type of association. Expected `collection` or `model` to be defined.')
  });

  await Promise.all(promises);
}

/**
 * When this model is being deleted, parse and update the referred-to models accordingly.
 */
export async function relationsDelete(model: FirestoreConnectorModel, ref: Reference, prevData: DocumentData, transaction: TransactionWrapper) {
  await relationsUpdate(model, ref, prevData, undefined, transaction); 
}

/**
 * When this model is being creted, parse and update the referred-to models accordingly.
 */
export async function relationsCreate(model: FirestoreConnectorModel, ref: Reference, newData: DocumentData, transaction: TransactionWrapper) {
  await relationsUpdate(model, ref, undefined, newData, transaction); 
}










interface ReverseAssocDetails {
  model: FirestoreConnectorModel
  assoc: StrapiAssociation
}


function getReverseAssocByAssoc(thisAssoc: StrapiAssociation): ReverseAssocDetails | undefined {
  if ((thisAssoc.collection || thisAssoc.model) === '*') {
    // Polymorphic relation
    return undefined;
  }
  
  const model = strapi.db.getModelByAssoc(thisAssoc);
  return getReverseAssocByModel(model, thisAssoc);
}

function getReverseAssocByModel(model: FirestoreConnectorModel | undefined, thisAssoc: StrapiAssociation): ReverseAssocDetails {
  if (!model) {
    throw new Error(`Associated model "${thisAssoc.collection || thisAssoc.model}" not found.`);
  }

  const assoc = model.associations.find(a => a.alias === thisAssoc.via);
  if (!assoc) {
    throw new Error(`Related attribute "${thisAssoc.via}" on the associated model "${model.globalId}" not found.`);
  }

  return {
    model,
    assoc,
  };
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

function valueAsArray(data: DocumentData | undefined, { alias, nature }: StrapiAssociation, reverse: ReverseAssocDetails | undefined, strict: boolean): Reference[] | undefined {
  if (data) {
    const value = coerceReference(data[alias] || [], reverse?.model, strict);
    if (!Array.isArray(value)) {
      throw new Error(`Value of ${nature} association must be an array.`);
    }
    return value;
  } else {
    return undefined;
  }
}

function valueAsSingle(data: DocumentData | undefined, { alias, nature }: StrapiAssociation, reverse: ReverseAssocDetails | undefined, strict: boolean): Reference | null | undefined {
  if (data) {
    const value = data[alias] || null;
    if (Array.isArray(value)) {
      throw new Error(`Value of ${nature} association must not be an array.`);
    }
    return coerceToReferenceSingle(value, reverse?.model, strict);
  } else {
    return undefined;
  }
}

function getModelByRef(ref: Reference): FirestoreConnectorModel | undefined {
  const collectionName = ref.parent.path;
  return strapi.db.getModelByCollectionName(collectionName);
}
