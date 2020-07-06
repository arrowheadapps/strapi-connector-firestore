import * as _ from 'lodash';
import { DocumentReference, Firestore } from '@google-cloud/firestore';
import type { FirestoreConnectorModel } from '../types';
import { Reference, parseDeepReference } from './queryable-collection';


export function getModel(model: string, plugin: string): FirestoreConnectorModel | undefined {
  return (
    _.get(strapi.plugins, [plugin, 'models', model]) ||
    _.get(strapi, ['models', model]) ||
    undefined
  );
};

export function refEquals(a: Reference | null, b: Reference | null): boolean {
  if (typeof a === 'string') {
    return a === b;
  } else if (a) {
    return a.id === ((b as any) || {}).id;
  }
  return false;
}

export function parseRef(ref: Reference, instance: Firestore) {
  if (typeof ref === 'string') {
    return parseDeepReference(ref, instance);
  } else {
    return ref;
  }
}

export function getDocRef(value: any, model: FirestoreConnectorModel): Reference | Reference[] | null {
  if (_.isArray(value)) {
    return value.map(v => singleDocRef(v, model)!).filter(Boolean);
  } else {
    return singleDocRef(value, model);
  }
}

function singleDocRef(value: any, model: FirestoreConnectorModel): Reference | null {
  if (value instanceof DocumentReference) {
    return value;
  }

  // FIXME:
  // Parse references to flattened documents
  const id = (typeof value === 'string') ? value : _.get(value, model.primaryKey);
  if (id) {
    model.doc(id);
  }
  
  return null;
}
