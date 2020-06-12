import * as _ from 'lodash';
import * as firebase from 'firebase-admin';
import { FirestoreConnectorModel } from './types';


export function getModel(model: string, plugin: string): FirestoreConnectorModel | undefined {
  return (
    _.get(strapi.plugins, [plugin, 'models', model]) ||
    _.get(strapi, ['models', model]) ||
    undefined
  );
};


export function getDocRef(value: any, model: FirestoreConnectorModel): firebase.firestore.DocumentReference | firebase.firestore.DocumentReference[] | null {
  return value = value instanceof firebase.firestore.DocumentReference
    ? value
    : value 
      ? _.isArray(value) 
        ? value.map(v => getDocRef(v, model)).filter(ref => ref) as firebase.firestore.DocumentReference[]
        : model.doc(_.get(value, model.primaryKey, value))
      : null;
}
