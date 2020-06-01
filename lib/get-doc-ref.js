'use strict';

const _ = require('lodash');
const firebase = require('firebase-admin');

const getModel = function(model, plugin) {
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
const getDocRef = (value, model) => {
  return value = value instanceof firebase.firestore.DocumentReference
    ? value
    : value 
      ? _.isArray(value) 
        ? value.map(v => getDocRef(v, model))
        : model.doc(_.get(value, model.primaryKey, value))
      : null;
}

module.exports = { getDocRef, getModel };
