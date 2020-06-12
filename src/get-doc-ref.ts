import * as _ from 'lodash';
import * as firebase from 'firebase-admin';

export function getModel(model, plugin) {
  return (
    _.get(strapi.plugins, [plugin, 'models', model]) ||
    _.get(strapi, ['models', model]) ||
    undefined
  );
};

/**
 * 
 * @param {any} value 
 * @param {FirebaseFirestore.CollectionReference} model 
 * @returns {FirebaseFirestore.DocumentReference | FirebaseFirestore.DocumentReference[] | null}
 */
export function getDocRef(value, model) {
  return value = value instanceof firebase.firestore.DocumentReference
    ? value
    : value 
      ? _.isArray(value) 
        ? value.map(v => getDocRef(v, model))
        : model.doc(_.get(value, model.primaryKey, value))
      : null;
}
