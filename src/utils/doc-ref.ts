import * as _ from 'lodash';
import * as path from 'path';
import { DocumentReference, Firestore, DocumentData } from '@google-cloud/firestore';
import type { FirestoreConnectorModel } from '../types';
import type { Reference, DeepReference } from './queryable-collection';


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
    return a.path === ((b as any) || {}).path;
  }
  return false;
}

export function parseRef<T = DocumentData>(ref: Reference<T>, instance: Firestore) {
  if (typeof ref === 'string') {
    return parseDeepReference(ref, instance);
  } else {
    return ref;
  }
}

export function parseDeepReference(ref: DeepReference, instance: Firestore) {

  const lastSlash = ref.lastIndexOf('/');
  const id = ref.slice(lastSlash + 1);
  if ((lastSlash === -1) || !id) {
    throw new Error('Reference has invalid format');
  }

  const doc = instance.doc(ref.slice(0, lastSlash));

  return {
    doc,
    id,
    path: path.posix.join(doc.path, id)
  }
}

export function coerceToReference(value: any, to: FirestoreConnectorModel): Reference | Reference[] | null {
  if (_.isArray(value)) {
    return value.map(v => coerceToReferenceSingle(v, to)!).filter(Boolean);
  } else {
    return coerceToReferenceSingle(value, to);
  }
}

function coerceToReferenceSingle(value: any, to: FirestoreConnectorModel): Reference | null {
  if (value instanceof DocumentReference) {
    return value;
  }

  const id = (typeof value === 'string') ? value : _.get(value, to.primaryKey, null);

  if (id) {
    const lastSlash = id.lastIndexOf('/');
    if (lastSlash === -1) {
      // No slash, so it isn't a full path
      // So assume it is just an ID
      return to.doc(id);
    } else {
      return id;
    }
  }
  
  return null;
}
