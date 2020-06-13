import * as _ from 'lodash';
import { FieldValue, Transaction, DocumentReference } from '@google-cloud/firestore';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { FirestoreConnectorModel } from './types';
const { models: { getValuePrimaryKey } } = require('strapi-utils');

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

const addRelationMorph = (model: FirestoreConnectorModel, params: any, transaction?: Transaction) => {
  const { id, alias, refId, ref, field, filter } = params;

  setMerge(
    model.doc(id), 
    FieldValue.arrayUnion({
      [alias]: {
        ref: refId,
        kind: ref,
        [filter]: field,
      },
    }),
    transaction
  );
};

const removeRelationMorph = async (model: FirestoreConnectorModel, params: any, transaction?: Transaction) => {
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
      setMerge(model.doc(params.id), FieldValue.arrayRemove(value));
    };

  } else {

    const q = model.where(alias, 'array-contains', value);
    const docs = (await (transaction ? transaction.get(q) : q.get())).docs;

    return () => {
      docs.forEach(d => {
        setMerge(d.ref, FieldValue.arrayRemove(value), transaction);
      });
    };
  }
};


const setMerge = (ref: DocumentReference, data: any, transaction?: Transaction) => {
  transaction
    ? transaction.set(ref, data, { merge: true })
    : ref.set(data, { merge: true });
}


export async function updateRelations(model: FirestoreConnectorModel, params: any, transaction?: Transaction) {
  const primaryKeyValue = getValuePrimaryKey(params, model.primaryKey);

  const ref = model.doc(primaryKeyValue);
  const { entry, data } = params;

  const relationUpdates: Promise<any>[] = [];
  const writes: (() => void)[] = [];

  // Only update fields which are on this document.
  const values = Object.keys(removeUndefinedKeys(params.values)).reduce((acc, attribute) => {
    const details = model._attributes[attribute];
    const association = model.associations.find(x => x.alias === attribute);

    const assocModel = getModel(details.model || details.collection, details.plugin);
    if (!assocModel) {
      throw new Error('Associated model no longer exists');
    }

    const currentRef = getDocRef(entry[attribute], assocModel);
    const newRef = getDocRef(params.values[attribute], assocModel);

    switch (association.nature) {
      case 'oneWay': {
        if (_.isArray(newRef)) {
          throw new Error('oneWay relation cannot be an array');
        }
        return _.set(acc, attribute, newRef);
      }

      case 'oneToOne': {
        if (_.isArray(currentRef) || _.isArray(newRef)) {
          throw new Error('oneToOne relation cannot be an array');
        }

        // if value is the same don't do anything
        if (newRef?.id === currentRef?.id) return acc;

        // if the value is null, set field to null on both sides
        if (!newRef) {
          if (currentRef) {
            writes.push(() => setMerge(currentRef, { [details.via]: null }, transaction));
          }
          return _.set(acc, attribute, null);
        }

        // set old relations to null
        relationUpdates.push((transaction ? transaction.get(newRef) : newRef.get()).then(snap => {
          const d = snap.data();
          if (d && d[details.via]) {
            const oldLink = getDocRef(d[details.via], assocModel);
            if (oldLink) {
              writes.push(() => setMerge(oldLink as DocumentReference, { [attribute]: null }));
            }
          }

          // set new relation
          writes.push(() => setMerge(newRef, { [details.via]: ref }));

        }));
        return _.set(acc, attribute, newRef);
      }

      case 'oneToMany': {
        // set relation to null for all the ids not in the list
        const currentArray = currentRef ? _.castArray(currentRef): [];
        const newArray = newRef ? _.castArray(newRef) : [];
        const toRemove = _.differenceWith(currentArray, newArray, (a, b) => a.id === b.id);

        writes.push(() => {
          toRemove.forEach(r => {
            setMerge(r, { [details.via]: null });
          });
          newArray.map(r => {
            setMerge(r, { [details.via]: ref });
          });
        });
        
        return acc;
      }
      
      case 'manyToOne': {
        return _.set(acc, attribute, newRef);
      }

      case 'manyWay':
      case 'manyToMany': {
        if (association.dominant) {
          return _.set(acc, attribute, newRef);
        }
        if (!_.isArray(currentRef) || !_.isArray(newRef)) {
          throw new Error('manyToMany relation must be an array');
        }

        writes.push(() => {
          currentRef.map(v => {
            setMerge(v, { [association.via]: FieldValue.arrayRemove(ref) });
          });
          newRef.map(v => {
            setMerge(v, { [association.via]: FieldValue.arrayUnion(ref) });
          });
        });

        return acc;
      }

      // media -> model
      case 'manyMorphToMany':
      case 'manyMorphToOne': {

        const newValue = params.values[attribute];
        if (!_.isArray(newValue)) {
          throw new Error('manyMorphToMany or manyMorphToOne relation must be an array');
        }

        relationUpdates.push(Promise.all(newValue.map(async obj => {
          const refModel = strapi.getModel(obj.ref, obj.source);

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
              setMerge(refModel.doc(obj.refId), {
                [obj.field]: ref
              }, transaction);
            });
          } else {
            writes.push(() => {
              createRelation();
              setMerge(refModel.doc(obj.refId), FieldValue.arrayUnion(ref), transaction);
            });
          }
        })));
        break;
      }

      // model -> media
      case 'oneToManyMorph':
      case 'manyToManyMorph': {
        const currentValue = entry[attribute];
        const newValue = params.values[attribute];

        // Compare array of ID to find deleted files.
        const currentIds = transformToArrayID(currentValue, model.primaryKey);
        const newIds = transformToArrayID(newValue, model.primaryKey);
        const toAdd = _.difference(newIds, currentIds);
        const toRemove = _.difference(currentIds, newIds);

        const morphModel = getModel(details.model || details.collection, details.plugin);

        _.set(acc, attribute, _.castArray(newIds));

        relationUpdates.push(Promise.all(toRemove.map(id => {
          return removeRelationMorph(morphModel!, {
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
            return addRelationMorph(morphModel!, {
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

export async function deleteRelations(model: FirestoreConnectorModel, params: any, transaction?: Transaction) {
  const { data: entry } = params;

  const primaryKeyValue = entry[model.primaryKey];
  const ref = model.doc(primaryKeyValue);

  const writes: (() => void)[] = [];
  await Promise.all(
    model.associations.map(async association => {
      const { nature, via, dominant, alias } = association;
      const details = model._attributes[alias];
  
      const assocModel = getModel(details.model || details.collection, details.plugin);
      if (!assocModel) {
        throw new Error('Associated model no longer exists');
      }
      const currentValue = getDocRef(entry[alias], assocModel);

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
          writes.push(() => setMerge(currentValue, { [via]: null }, transaction));
          return;
        }

        case 'manyToMany':
        case 'manyToOne': {
          if (!via || dominant || !currentValue) {
            return;
          }
          if (_.isArray(currentValue)) {
            writes.push(() => currentValue.forEach(v => {
              setMerge(v, { [via]: FieldValue.arrayRemove(ref) });
            }));
          } else {
            writes.push(() => setMerge(currentValue, { [via]: FieldValue.arrayRemove(ref) }));
          }
          return;
        }

        case 'oneToManyMorph':
        case 'manyToManyMorph': {
          // delete relation inside of the ref model
          const targetModel: FirestoreConnectorModel = strapi.db.getModel(
            association.model || association.collection,
            association.plugin
          );

          // ignore them ghost relations
          if (!targetModel) return;

          const element = {
            ref: primaryKeyValue,
            kind: model.globalId,
            [association.filter]: association.alias,
          };

          setMerge(ref, { [via]: FieldValue.arrayRemove(element) }, transaction);
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

                const q = targetModel.where(targetModel.primaryKey, '==', val.ref && (val.ref._id || val.ref));
                const docs = (await (transaction ? transaction.get(q) : q.get())).docs;

                if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
                  writes.push(() => docs.forEach(d => {
                    setMerge(d, { [field]: null });
                  }));
                } else {
                  writes.push(() => docs.forEach(d => {
                    setMerge(d, { [field]: FieldValue.arrayRemove(ref) });
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

  writes.forEach(write => write());
}
  