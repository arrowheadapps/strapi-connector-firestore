/**
 * Module dependencies
 */

// Public node modules.
import * as _ from 'lodash';
import * as firebase from 'firebase-admin';
import { getDocRef, getModel } from './get-doc-ref';
import { FirestoreConnectorModel } from './types';

// Utils
const {
  models: { getValuePrimaryKey },
} = require('strapi-utils');

function transformToArrayID(array: any, pk?: string): string[] {
  if (_.isArray(array)) {
    return array
      .map(value => value && (getValuePrimaryKey(value, pk) || value))
      .filter(n => n)
      .map(val => _.toString(val));
  }

  return transformToArrayID([array]);
};

const removeUndefinedKeys = (obj = {}) => _.pickBy(obj, _.negate(_.isUndefined));

const addRelationMorph = (model: FirestoreConnectorModel, params: any, transaction?: firebase.firestore.Transaction) => {
  const { id, alias, refId, ref, field, filter } = params;

  setMerge(
    model.doc(id), 
    firebase.firestore.FieldValue.arrayUnion({
      [alias]: {
        ref: refId,
        kind: ref,
        [filter]: field,
      },
    }),
    transaction
  );
};

const removeRelationMorph = async (model: FirestoreConnectorModel, params: any, transaction?: firebase.firestore.Transaction) => {
  const { alias } = params;

  const value = {
    [alias]: {
      ref: params.refId,
      kind: params.ref,
      [params.filter]: params.field,
    },
  };

  // if entry id is provided simply query it
  if (params.id) {
    return () => {
      setMerge(model.doc(params.id), firebase.firestore.FieldValue.arrayRemove(value));
    };

  } else {

    const q = model.where(alias, 'array-contains', value);
    const docs = (await (transaction ? transaction.get(q) : q.get())).docs;

    return () => {
      docs.forEach(d => {
        setMerge(d.ref, firebase.firestore.FieldValue.arrayRemove(value), transaction);
      });
    };
  }
};


const setMerge = (ref: firebase.firestore.DocumentReference, data: any, transaction?: firebase.firestore.Transaction) => {
  transaction
    ? transaction.set(ref, data, { merge: true })
    : ref.set(data, { merge: true });
}


export async function updateRelations(model: FirestoreConnectorModel, params: any, transaction?: firebase.firestore.Transaction) {
  const primaryKeyValue = getValuePrimaryKey(params, model.primaryKey);

  const ref = model.doc(primaryKeyValue);
  const { entry, data } = params;

  const relationUpdates: Promise<any>[] = [];
  const writes: (() => void)[] = [];

  // Only update fields which are on this document.
  const values = Object.keys(removeUndefinedKeys(params.values)).reduce((acc, attribute) => {
    const details = model._attributes[attribute];
    const assocModel = getModel(details.model || details.collection, details.plugin);
    const association = model.associations.find(x => x.alias === attribute);

    const currentValue = getDocRef(entry[attribute], assocModel);
    const newValue = getDocRef(params.values[attribute], assocModel);


    // set simple attributes
    if (!association && _.get(details, 'isVirtual') !== true) {
      return _.set(acc, attribute, newValue);
    }


    switch (association.nature) {
      case 'oneWay': {
        return _.set(acc, attribute, newValue);
      }
      case 'oneToOne': {
        // if value is the same don't do anything
        if (currentValue.id === currentValue.id) return acc;

        // if the value is null, set field to null on both sides
        if (_.isNull(newValue)) {
          writes.push(() => setMerge(newValue, { [details.via]: null }, transaction));
          return _.set(acc, attribute, null);
        }

        // set old relations to null
        relationUpdates.push((transaction ? transaction.get(newValue) : newValue.get()).then(snap => {
          const d = snap.data();
          if (d && d[details.via]) {
            const oldLink = getDocRef(d[details.via], assocModel);
            writes.push(() => setMerge(oldLink, { [attribute]: null }));
          }

          // set new relation
          writes.push(() => setMerge(newValue, { [details.via]: ref }));
        }));
        return _.set(acc, attribute, newValue);
      }
      case 'oneToMany': {
        // set relation to null for all the ids not in the list
        const attributeIds = currentValue;
        const toRemove = _.differenceWith(attributeIds, newValue, (a, b) => a.id == b.id);

        writes.push(() => {
          toRemove.forEach(r => {
            setMerge(r, { [details.via]: null });
          });
          _.castArray(newValue).map(r => {
            setMerge(r, { [details.via]: ref });
          });
        });
        
        return acc;
      }
      case 'manyToOne': {
        return _.set(acc, attribute, newValue);
      }
      case 'manyWay':
      case 'manyToMany': {
        if (association.dominant) {
          return _.set(acc, attribute, newValue);
        }

        writes.push(() => {
          currentValue.map(v => {
            setMerge(v, { [association.via]: firebase.firestore.FieldValue.arrayRemove(ref) });
          });
          newValue.map(v => {
            setMerge(v, { [association.via]: firebase.firestore.FieldValue.arrayUnion(ref) });
          });
        });

        return acc;
      }
      // media -> model
      case 'manyMorphToMany':
      case 'manyMorphToOne': {
        relationUpdates.push(Promise.all(newValue.map(async obj => {
          const refModel: FirestoreConnectorModel = strapi.getModel(obj.ref, obj.source);

          const createRelation = () => {
            return addRelationMorph(model, {
              id: entry[model.primaryKey],
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
            writes.push(await removeRelationMorph(model, {
              alias: association.alias,
              ref: obj.kind || refModel.globalId,
              refId: model.doc(obj.refId),
              field: obj.field,
              filter: association.filter,
            }));
            writes.push(() => {
              createRelation();
              setMerge(refModel.doc(refId), {
                [obj.field]: ref
              }, transaction);
            });
          } else {
            writes.push(() => {
              createRelation();
              setMerge(refModel.doc(obj.refId), firebase.firestore.FieldValue.arrayUnion(ref), transaction);
            });
          }
        })));
        break;
      }
      // model -> media
      case 'oneToManyMorph':
      case 'manyToManyMorph': {
        // Compare array of ID to find deleted files.
        const currentIds = transformToArrayID(currentValue, model.primaryKey);
        const newIds = transformToArrayID(newValue, model.primaryKey);

        const toAdd = _.difference(newIds, currentIds);
        const toRemove = _.difference(currentIds, newIds);

        const morphModel = getModel(details.model || details.collection, details.plugin);

        if (!Array.isArray(newValue)) {
          _.set(acc, attribute, newIds[0]);
        } else {
          _.set(acc, attribute, newIds);
        }

        relationUpdates.push(Promise.all(toRemove.map(id => {
          return removeRelationMorph(morphModel, {
            id,
            alias: association.via,
            ref: model.globalId,
            refId: ref,
            field: association.alias,
            filter: association.filter,
          });
        })).then(w => writes.push(...w)));

        writes.push(() => {
          toAdd.forEach(id => {
            return addRelationMorph(morphModel, {
              id,
              alias: association.via,
              ref: model.globalId,
              refId: ref,
              field: association.alias,
              filter: association.filter,
            }, transaction);
          })
        });

        break;
      }
      case 'oneMorphToOne':
      case 'oneMorphToMany':
        break;
      default:
    }

    return acc;
  }, {});

  await Promise.all(relationUpdates);
  writes.forEach(write => write());

  return { ...data, ...values };
}

export async function deleteRelations(model: FirestoreConnectorModel, params: any, transaction?: firebase.firestore.Transaction) {
  const { data: entry } = params;

  const primaryKeyValue = entry[model.primaryKey];
  const ref = model.doc(primaryKeyValue);

  const writes = [];
  await Promise.all(
    model.associations.map(async association => {
      const { nature, via, dominant, alias } = association;
      const currentValue = getDocRef(entry[alias]);

      // TODO: delete all the ref to the model

      switch (nature) {
        case 'oneWay':
        case 'manyWay': {
          return;
        }
        case 'oneToMany':
        case 'oneToOne': {
          if (!via) {
            return;
          }

          writes.push(() => setMerge(currentValue, { [via]: null }, transaction));

        }
        case 'manyToMany':
        case 'manyToOne': {
          if (!via || dominant) {
            return;
          }

          if (_.isArray(currentValue)) {
            writes.push(() => currentValue.forEach(v => {
              setMerge(v, { [via]: firebase.firestore.FieldValue.arrayRemove(ref) });
            }));
          } else {
            writes.push(() => setMerge(currentValue, { [via]: firebase.firestore.FieldValue.arrayRemove(ref) }));
          }
        }
        case 'oneToManyMorph':
        case 'manyToManyMorph': {
          // delete relation inside of the ref model

          const targetModel = strapi.db.getModel(
            association.model || association.collection,
            association.plugin
          );

          // ignore them ghost relations
          if (!targetModel) return;

          writes.push(await removeRelationMorph(targetModel, {
            ref: targetModel.globalId,
            refId: model.doc(obj.refId),
            field: association.alias,
            filter: association.filter,
          }));
        }
        case 'manyMorphToMany':
        case 'manyMorphToOne': {
          // delete relation inside of the ref model

          if (Array.isArray(entry[association.alias])) {
            return Promise.all(
              entry[association.alias].map(val => {
                /** @type {FirebaseFirestore.CollectionReference} */
                const targetModel = strapi.db.getModelByGlobalId(val.kind);

                // ignore them ghost relations
                if (!targetModel) return;

                const field = val[association.filter];
                const reverseAssoc = targetModel.associations.find(
                  assoc => assoc.alias === field
                );

                const q = targetModel.where(targetModel.primaryKey, '==', val.ref && (val.ref._id || val.ref));
                const docs = (await (transaction ? transaction.get(q) : q.get())).docs;

                if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
                  writes.push(() => docs.forEach(d => {
                    setMerge(d, { [field]: null });
                  }));
                } else {
                  writes.push(() => docs.forEach(d => {
                    setMerge(d, { [field]: firebase.firestore.FieldValue.arrayRemove(ref) });
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
      }
    })
  );

  writes.forEach(write => write());
}
  