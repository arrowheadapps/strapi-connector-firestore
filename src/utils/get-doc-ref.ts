import * as _ from 'lodash';
import { DocumentReference } from '@google-cloud/firestore';
import { FirestoreConnectorModel } from '../types';


export function getModel(model: string, plugin: string): FirestoreConnectorModel | undefined {
  return (
    _.get(strapi.plugins, [plugin, 'models', model]) ||
    _.get(strapi, ['models', model]) ||
    undefined
  );
};


export function getDocRef(value: any, model: FirestoreConnectorModel): DocumentReference | DocumentReference[] | null {
  return value = value instanceof DocumentReference
    ? value
    : value 
      ? _.isArray(value) 
        ? value.map(v => getDocRef(v, model)).filter(ref => ref) as DocumentReference[]
        : model.doc(_.get(value, model.primaryKey, value))
      : null;
}
