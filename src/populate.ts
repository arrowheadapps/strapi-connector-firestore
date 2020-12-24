import * as _ from 'lodash';
import { getComponentModel } from './utils/validate-components';
import { coerceReference } from './utils/coerce';
import type { FirestoreConnectorModel } from './types';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Reference, Snapshot } from './utils/queryable-collection';
import { StatusError } from './utils/status-error';
import { AsyncSnapshot, findReverse, getReverseAssocByAssoc, ReverseActionParams } from './relations';


export type PartialSnapshot = Pick<Snapshot, 'data'> & Pick<Snapshot, 'ref'>


/**
 * Populates all the requested relational field on the given documents.
 */
export async function populateDocs<T>(model: FirestoreConnectorModel<T>, docs: PartialSnapshot[], populateFields: string[], transaction: TransactionWrapper) {
  return await Promise.all(docs.map(doc => populateDoc(model, doc, populateFields, transaction)));
};


/**
 * Populates all the requested relational field on the given document.
 */
export async function populateDoc<T>(model: FirestoreConnectorModel<T>, doc: PartialSnapshot, populateFields: string[], transaction: TransactionWrapper) {
  const values = doc.data();
  if (!values) {
    throw new StatusError(`Document not found: ${doc.ref.path}`, 404);
  }

  // Clone the object (shallow)
  const data = Object.assign({}, values);

  const relationPromises =  Promise.all(populateFields.map(f => populateField(model, doc.ref, f, data, transaction)));

  const componentPromises = Promise.all(model.componentKeys.map(async componentKey => {
    const component = data[componentKey];
    if (component) {
      // FIXME:
      // `ref` is pointing to the parent document that the component is embedded into
      // In the future, components embedding or not may be configurable
      // so we need a way to handle and differentiate this

      if (Array.isArray(component)) {
        data[componentKey] = await Promise.all(component.map(c => {
          const componentModel = getComponentModel(model, componentKey, c);
          return populateDoc(componentModel, { ref: doc.ref, data: () => c }, componentModel.defaultPopulate, transaction);
        }));
      } else {
        const componentModel = getComponentModel(model, componentKey, component);
        data[componentKey] = await populateDoc(componentModel, { ref: doc.ref, data: () => component }, componentModel.defaultPopulate, transaction);
      }
    }
  }));

  await Promise.all([relationPromises, componentPromises]);

  return data;
}


export async function populateField(model: FirestoreConnectorModel, docRef: Reference, field: string, data: any, transaction: TransactionWrapper) {
  const assoc = model.associations.find(assoc => assoc.alias === field)!;
  const reverse = getReverseAssocByAssoc(assoc);

  const processPopulatedDoc = async (snap: AsyncSnapshot) => {
    try {
      return await snap.data();
    } catch {
      // TODO:
      // Should we through an error if the reference can't be found
      // or just silently omit it?
      // For now we log a warning
      strapi.log.warn(`The document referenced by "${snap.ref.path}" no longer exists`);
      return null;
    }
  }

  let action: (refs: ReverseActionParams[]) => Promise<any>;
  if (assoc.collection) {
    action = async (refs) => {
      const datas = await Promise.all(refs.map(processPopulatedDoc));
      data[field] = datas.filter(d => d != null);
    };
  } else {
    action = async ([ref]) => {
      if (ref) {
        data[field] = await processPopulatedDoc(ref);
      } else {
        data[field] = null;
      }
    };
  }

  let refs: Reference[];
  if (assoc.dominant) {
    const ref = coerceReference(data[field], reverse?.model);
    if (assoc.collection) {
      refs = ref
        ? _.castArray(ref)
        : [];
    } else {
      refs = ref
        ? Array.isArray(ref) ? ref.slice(0, 1) : [ref]
        : [];
    }
  } else {
    refs = [];
  }

  await findReverse({
    model,
    ref: docRef,
    assoc: assoc,
    reverse,
    transaction,
    removed: {
      refs,
      action,
    },
    // Trigger special case for `removed` actions
    // to be performed
    added: undefined,
  });
}
