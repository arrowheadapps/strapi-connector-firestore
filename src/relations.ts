import * as _ from 'lodash';
import { FieldValue, DocumentReference, DocumentData } from '@google-cloud/firestore';
import type { FirestoreConnectorModel } from './model';
import type { StrapiAssociation } from './types';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference, Snapshot } from './utils/queryable-collection';
import { DeepReference } from './utils/deep-reference';
import { coerceReference, coerceToReferenceSingle } from './utils/coerce';
import { StatusError } from './utils/status-error';



/**
 * Parse relation attributes on this updated model and update the referred-to
 * models accordingly.
 */
export async function relationsUpdate<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference, prevData: T | undefined, newData: T | undefined, transaction: TransactionWrapper) {
  const promises: Promise<any>[] = [];

  model.associations.forEach(assoc => {

    const reverse = getReverseAssocByAssoc(assoc);

    const setReverse = (r: ReverseActionParams, set: boolean) => {
      // Store a plain reference for normal relations
      // but an object with extra info for polymorphic relations
      const refValue = r.refValue || makeRefValue(r.assoc, assoc, ref);
      
      const reverseValue = set
        ? (r.assoc.collection ? FieldValue.arrayUnion(refValue) : refValue)
        : (r.assoc.collection ? FieldValue.arrayRemove(refValue) : null);

      return r.model.db.update(r.ref, { [r.assoc.alias]: reverseValue }, transaction);
    };

    const findAndSetReverse = (added: Reference[], removed: Reference[]) => {
      promises.push(
        findReverse({
          model,
          ref,
          assoc,
          reverse,
          transaction,
          added: {
            refs: added,
            action: (refs) => Promise.all(refs.map(r => setReverse(r, true))),
          },
          removed: {
            refs: removed,
            action: (refs) => Promise.all(refs.map(r => setReverse(r, false))),
          },
        })
      )
    };

    const setThis = (value: Reference | Reference[] | null) => {
      if (newData) {
        if (assoc.dominant) {
          const refValue = value && (Array.isArray(value)
            ? value.map(v => makeRefValue(assoc, reverse?.assoc, v))
            : makeRefValue(assoc, reverse?.assoc, value));

          _.set(newData, assoc.alias, refValue);
        } else {
          _.unset(newData, assoc.alias);
        }
      }
    };

    if (assoc.collection) {
      const prevValue = valueAsArray(prevData, assoc, reverse, true);
      const newValue = valueAsArray(newData, assoc, reverse, true);
      
      // Set the value stored in this document appropriately
      setThis(newValue || []);

      // Set the value stored in the references documents appropriately
      const removed = _.differenceWith(prevValue, newValue || [], refEquals);
      const added = _.differenceWith(newValue, prevValue || [], refEquals)
      findAndSetReverse(added, removed);

      return;
    }

    if (assoc.model) {
      const prevValue = valueAsSingle(prevData, assoc, reverse, true);
      const newValue = valueAsSingle(newData, assoc, reverse, true);
      
      // Set the value stored in this document appropriately
      setThis(newValue || null);

      // Set the value stored in the references documents appropriately
      const added = newValue ? [newValue] : [];
      const removed = prevValue ? [prevValue] : [];
      findAndSetReverse(added, removed);

      return;
    }

    throw new Error('Unexpected type of association. Expected `collection` or `model` to be defined.')
  });

  await Promise.all(promises);
}

/**
 * When this model is being deleted, parse and update the referred-to models accordingly.
 */
export async function relationsDelete<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference, prevData: T, transaction: TransactionWrapper) {
  await relationsUpdate(model, ref, prevData, undefined, transaction); 
}

/**
 * When this model is being creted, parse and update the referred-to models accordingly.
 */
export async function relationsCreate<T extends object>(model: FirestoreConnectorModel<T>, ref: Reference, newData: T, transaction: TransactionWrapper) {
  await relationsUpdate(model, ref, undefined, newData, transaction); 
}



export type MorphRefValue = {
  ref: Reference
} & {
  [field: string]: string
}

export interface ReverseAssocDetails {
  model: FirestoreConnectorModel
  assoc: StrapiAssociation
}

export interface AsyncSnapshot<T = DocumentData> {
  ref: Reference
  /**
   * Returns a `Promise` that resolves with the document data
   * or rejects if the document referred to by `ref` doesn't exist.
   */
  data: () => Promise<T>
}

export interface ReverseAction {
  refs: Reference[]
  action: (refs: ReverseActionParams[]) => Promise<any>
}

export interface ReverseActionParams extends AsyncSnapshot, ReverseAssocDetails {
  /**
   * If the shapshot has been found by querying the related collection,
   * then this is the value of the reference (pointing to this document)
   * that was queried for.
   */
  refValue?: MorphRefValue
}

export interface FindReverseArgs {
  model: FirestoreConnectorModel<any>
  ref: Reference
  assoc: StrapiAssociation
  transaction: TransactionWrapper

  /**
   * The opposite (reverse) end of the association.
   * Pass `undefined` if it is polymorphic (i.e.) the other 
   * end is not hardcoded.
   */
  reverse: ReverseAssocDetails | undefined
  
  /**
   * Actions to perform on related documents that are 
   * new to this relation.
   * 
   * If this is `undefined` then a special case will be triggered
   * where `removed` actions are performed even when the reverse
   * association isn't dominant.
   */
  added?: ReverseAction

  /**
   * Actions to perform on related documents that are existing on this relation.
   */
  removed?: ReverseAction
}

/**
 * Centralised logic for finding the targets on the opposite (reverse) end
 * of relations and performing actions on those targets.
 */
export async function findReverse({ model, ref, assoc, reverse, added, removed, transaction }: FindReverseArgs) {
  const promises: Promise<void>[] = [];
  const searchExisting = removed && !added;

  if (reverse) {
    // NORMAL RELATION (not polymorphic)

    if (reverse.assoc.dominant || searchExisting) {
      if (added) {
        promises.push(added.action(added.refs.map(r => actFromRef(reverse, r, transaction))));
      }

      if (removed) {
        if (assoc.dominant) {
          // Previous references were stored in this document
          // so we can find them directly
          promises.push(removed.action(removed.refs.map(r => actFromRef(reverse, r, transaction))));
        } else {
          // Previous references were not stored in this document
          // so we need to search for them
          const refValue = makeRefValue(reverse.assoc, assoc, ref);
          const q = reverse.assoc.model
            ? reverse.model.db.where(reverse.assoc.alias, '==', refValue)
            : reverse.model.db.where(reverse.assoc.alias, 'array-contains', refValue);

          promises.push(
            transaction.get(q).then(snap => {
              promises.push(removed.action(snap.docs.map(d => actFromSnap(reverse, d, refValue))));
            })
          );
        }
      }

    } else {
      // I.e. reverse.assoc.dominant == false
      // Other association is not dominant
      // so there is no storage on the other end
    }

  } else {
    // POLYMORPHIC RELATION

    // Assign this reference to new values
    if (added) {
      const refs = added.refs
        .map(morphRef => {
          const morphReverse = getReverseAssocByModel(getModelByRef(morphRef), assoc);
          if (morphReverse.assoc.dominant || searchExisting) {
            return actFromRef(morphReverse, morphRef, transaction);
          } else {
            return null!;
          }
        })
        .filter(r => r != null);
      
      promises.push(added.action(refs));
    }

    // Remove this reference from old values
    if (removed) {
      if (assoc.dominant) {
        // Previous references were stored in this document
        // so we can find them directly
        const refs = removed.refs
          .map(morphRef => {
            const morphReverse = getReverseAssocByModel(getModelByRef(morphRef), assoc);
            if (morphReverse.assoc.dominant || searchExisting) {
              return actFromRef(morphReverse, morphRef, transaction);
            } else {
              return null!;
            }
          })
          .filter(r => r != null);

        promises.push(removed.action(refs));
      } else {
        // Previous references were not stored in this document
        // so we need to search for them
        const relatedModels = model.morphRelatedModels[assoc.alias];

        const refsPromise = relatedModels.map(m => {
          const morphReverse = getReverseAssocByModel(m, assoc);
          if(morphReverse.assoc.dominant || searchExisting) {
            const refValue = makeRefValue(morphReverse.assoc, assoc, ref);
            const q = morphReverse.assoc.collection
              ? m.db.where(morphReverse.assoc.alias, 'array-contains', refValue)
              : m.db.where(morphReverse.assoc.alias, '==', refValue);
            return transaction.get(q).then(snap => {
              return snap.docs.map(d => actFromSnap(morphReverse, d, refValue));
            });
          } else {
            return Promise.resolve([]);
          }
        });

        promises.push(
          Promise.all(refsPromise).then(refs => {
            return removed.action(refs.flat());
          })
        );
      }
    }
  }

  await Promise.all(promises);
};








function actFromSnap(reverse: ReverseAssocDetails, snap: Snapshot, refValue: any): ReverseActionParams {
  return {
    ...reverse,
    refValue,
    ref: snap.ref,
    data: () => {
      const d = snap.data();
      if (!d) {
        throw new StatusError(`The document referred to by "${snap.ref.path}" doesn't exist`, 404);
      }
      return Promise.resolve(d);
    }
  }
}

function actFromRef(reverse: ReverseAssocDetails, ref: Reference, transaction: TransactionWrapper): ReverseActionParams {
  return {
    ...reverse,
    ref,
    data: () => transaction.get(ref).then(snap => {
      const d = snap.data();
      if (!d) {
        throw new StatusError(`The document referred to by "${ref.path}" doesn't exist`, 404);
      }
      return d;
    })
  }
}

export function getReverseAssocByAssoc(thisAssoc: StrapiAssociation): ReverseAssocDetails | undefined {
  if ((thisAssoc.collection || thisAssoc.model) === '*') {
    // Polymorphic relation
    return undefined;
  }
  
  const model = strapi.db.getModelByAssoc(thisAssoc);
  return getReverseAssocByModel(model, thisAssoc);
}

export function getReverseAssocByModel(model: FirestoreConnectorModel | undefined, thisAssoc: StrapiAssociation): ReverseAssocDetails {
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

function makeRefValue(assoc: StrapiAssociation, otherAssoc: StrapiAssociation | undefined, ref: Reference): MorphRefValue | Reference {
  if ((assoc.collection || assoc.model) == '*') {
    const value: any = { ref };
    if (assoc.filter) {
      if (!otherAssoc) {
        throw new Error('Cannot assign polymorphic reference because the filter is unknown.');
      }
      value[assoc.filter] = otherAssoc.alias;
    }
    return value;
  } else {
    return ref;
  }
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
