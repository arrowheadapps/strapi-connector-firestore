import * as _ from 'lodash';
import type { FirestoreConnectorModel } from '../model';
import type { Transaction } from '../db/transaction';
import { StatusError } from './status-error';
import { MorphReference } from '../db/morph-reference';
import { FieldOperation } from '../db/field-operation';
import { isEqualHandlingRef, Reference, Snapshot } from '../db/reference';
import { NormalReference } from '../db/normal-reference';
import { DeepReference } from '../db/deep-reference';


export interface AsyncSnapshot<R extends object> {
  ref: Reference<R>

  /**
   * Returns a `Promise` that resolves with the document data
   * or rejects if the document referred to by `ref` doesn't exist.
   */
  data(atomic?: boolean): Promise<R>
}


export interface RelationInfo<T extends object> {
  model: FirestoreConnectorModel<T>
  attr: RelationAttrInfo | undefined
  parentModels: RelationInfo<any>[] | undefined
}

export interface RelationAttrInfo {
  alias: string
  isArray: boolean
  filter: string | undefined
  isMorph: boolean

  /**
   * Indicates that this is a "virtual" attribute
   * which is metadata/index map for a repeatable component,
   * or a deep path to a non-repeatable component,
   * and the actual alias inside the component is this value.
   */
  actualAlias: { 
    componentAlias: string
    parentAlias: string
  } | undefined
  /**
   * Indicates that this is a metadata/index map, not a path to 
   * an actual attribute.
   */
  isMeta: boolean
}

export class RelationHandler<T extends object, R extends object = object> {

  constructor(
    private readonly thisEnd: RelationInfo<T>,
    private readonly otherEnds: RelationInfo<R>[],
  ) {
    if (!thisEnd.attr && !otherEnds.filter(e => e.attr).length) {
      throw new Error('Relation does not have any dominant ends defined');
    }

    if (otherEnds.some(e => e.model.isComponent && (!e.attr || thisEnd.attr))) {
      throw new Error('Relation cannot have a dominant reference to a component');
    }

  }

  /**
   * Gets the alias of this relation, or `undefined`
   * if this end of the relation is not dominant.
   */
  get alias(): string | undefined {
    return this.thisEnd.attr?.alias;
  }

  /**
   * Finds references to the related models on the given object.
   * The related models are not necessarily fetched.
   */
  async findRelated(ref: Reference<T>, data: T, transaction: Transaction): Promise<AsyncSnapshot<R>[]> {
    const { attr } = this.thisEnd;
    if (attr) {
      return this._getRefInfo(data, attr, transaction);
    } else {
      return await this._queryRelated(ref, transaction, false);
    }
  }


  /**
   * Updates the the related models on the given object.
   */
  async update(ref: Reference<T>, prevData: T | undefined, newData: T | undefined, editMode: 'create' | 'update', transaction: Transaction): Promise<void> {
    const { attr: thisAttr } = this.thisEnd;
    if (thisAttr) {
      // This end is dominant
      // So we know all the other ends directly without querying

      // Update operations will not touch keys that don't exist
      // If the data doesn't have the key, then don't update the relation because we aren't touching it
      // If newData is undefined then we are deleting and we do need to update the relation
      if ((editMode === 'update') && newData && !_.has(newData, thisAttr.alias)) {
        return;
      }

      const prevValues = this._getRefInfo(prevData, thisAttr, transaction);
      const newValues = this._getRefInfo(newData, thisAttr, transaction);

      // Set the value stored in this document appropriately
      this._setThis(newData, thisAttr, newValues.map(v => this._makeRefToOther(v.ref, thisAttr)));

      // Set the value stored in the references documents appropriately
      const removed = _.differenceWith(prevValues, newValues, (a, b) => isEqualHandlingRef(a.ref, b.ref));
      const added = _.differenceWith(newValues, prevValues, (a, b) => isEqualHandlingRef(a.ref, b.ref));
      await Promise.all([
        Promise.all(added.map(r => this._setRelated(r, ref, true, transaction))),
        Promise.all(removed.map(r => this._setRelated(r, ref, false, transaction)))
      ]);

    } else {
      // I.e. thisAttr == null (meaning this end isn't dominant)

      if (!newData) {
        // This end is being deleted and it is not dominant
        // so we need to search for the dangling references existing on other models
        const related = await this._queryRelated(ref, transaction, true);
        await Promise.all(
          related.map(r => this._setRelated(r, ref, false, transaction))
        );

      } else {
        // This end isn't dominant
        // But it isn't being deleted so there is 
        // no action required on the other side
      }
    }
  }


  /**
   * Populates the related models onto the given object 
   * for this relation.
   */
  async populateRelated(ref: Reference<T>, data: T, transaction: Transaction): Promise<void> {
    const { attr } = this.thisEnd;
    if (attr) {
      const related = await this.findRelated(ref, data, transaction);
      const values = await Promise.all(
        related.map(async snap => {
          try {
            return await snap.data();
          } catch {
            // TODO:
            // Should we through an error if the reference can't be found
            // or just silently omit it?
            // For now we log a warning
            strapi.log.warn(`The document referenced by "${snap.ref.path}" no longer exists`);
            return null!;
          }
        })
      );

      // The values will be correctly coerced
      // into and array or single value by the method below
      this._setThis(data, attr, values.filter(v => v != null));
    }
  }



  private get _singleOtherEnd(): RelationInfo<R> | undefined {
    return (this.otherEnds.length === 1) ? this.otherEnds[0] : undefined;
  }

  /**
   * Creates an appropriate `ReferenceShape` to store in the documents
   * at the other end, properly handling polymorphic references.
   * 
   * @param ref The reference to this
   * @param otherAttr Attribute info of the other end (which refers to this)
   */
  private _makeRefToThis(ref: Reference<T>, otherAttr: RelationAttrInfo): Reference<T> {
    if (otherAttr.isMorph && !(ref instanceof MorphReference)) {
      const { attr } = this.thisEnd;
      if (!attr && otherAttr.filter) {
        throw new Error('Polymorphic reference does not have the required information');
      }
      if ((ref instanceof NormalReference) || (ref instanceof DeepReference)) {
        ref = new MorphReference(ref, attr ? attr.alias : null);
      } else {
        throw new Error(`Unknown type of reference: ${ref}`);
      }
    }

    return ref;
  }

  /**
   * Checks the `Reference` to store in this document,
   * properly handling polymorphic references.
   * 
   * @param otherRef The reference to the other end
   */
  private _makeRefToOther(otherRef: Reference<R> | null | undefined, thisAttr: RelationAttrInfo): Reference<R> | null {
    if (otherRef) {
      if (thisAttr.isMorph && !(otherRef instanceof MorphReference)) {
        // The reference would have been coerced to an instance of MorphReference
        // only if it was an object with the required info
        throw new Error('Polymorphic reference does not have the required information');
      } else {
        return otherRef;
      }
    }
    return null;
  }

  private _setThis(data: T | undefined, { alias, isArray }: RelationAttrInfo, value: any) {
    if (data) {
      if (isArray) {
        const val = value ? _.castArray(value) : [];
        _.set(data, alias, val);
      } else {
        const val = value ? (Array.isArray(value) ?  value[0] || null : value) : null;
        _.set(data, alias, val);
      }
    }
  }

  private async _setRelated({ ref, attr, data, refValue }: InternalAsyncSnapshot<T, R>, thisRef: Reference<T>, set: boolean, transaction: Transaction) {
    if (attr) {
      refValue = refValue || this._makeRefToThis(thisRef, attr);
      const value = set
        ? (attr.isArray ? FieldOperation.arrayUnion(refValue) : refValue)
        : (attr.isArray ? FieldOperation.arrayRemove(refValue) : null);
      
      if (attr.isMeta && attr.actualAlias) {
        const { componentAlias, parentAlias } = attr.actualAlias;
        // The attribute is a metadata map for an array of components
        // This requires special handling
        // We need to atomically fetch and process the data then update
        // Extract a new object with only the fields that are being updated
        const prevData = await data(true);
        const newData: any = {};
        const components = _.get(prevData, parentAlias);
        _.set(newData, parentAlias, components);
        for (const component of _.castArray(components)) {
          if (component) {
            FieldOperation.apply(component, componentAlias, value);
          }
        }

        await transaction.update(ref, newData, { updateRelations: false });
      } else {
        await transaction.update(ref, { [attr.alias]: value } as object, { updateRelations: false });
      }
    }
  }

  private async _queryRelated(ref: Reference<T>, transaction: Transaction, atomic: boolean, otherEnds = this.otherEnds): Promise<InternalAsyncSnapshot<T, R>[]> {
    const snaps = otherEnds.map(async otherEnd => {
      const { model, attr, parentModels } = otherEnd;
      if (parentModels && parentModels.length) {
        // Find instances of the parent document containing
        // a component instance that references this
        return await this._queryRelated(ref, transaction, atomic, parentModels);
      }

      if (attr) {
        // The refValue will be coerced appropriately
        // by the model that is performing the query
        const refValue = this._makeRefToThis(ref, attr);
        let q = attr.isArray
          ? model.db.where(attr.alias, 'array-contains', refValue)
          : model.db.where(attr.alias, '==', refValue);
        if (model.options.maxQuerySize) {
          q = q.limit(model.options.maxQuerySize);
        }
        const snap = atomic
          ? await transaction.getAtomic(q)
          : await transaction.getNonAtomic(q);
        return snap.docs.map(d => asyncFromSnap(otherEnd, d, atomic, refValue, transaction));
      } else {
        return [];
      }
    });
    return (await Promise.all(snaps)).flat();
  }

  private _getRefInfo(data: T | undefined, thisAttr: RelationAttrInfo, transaction: Transaction): InternalAsyncSnapshot<T, R>[] {
    return _.castArray(_.get(data, thisAttr.alias) || [])
      .map(v => this._getSingleRefInfo(v, transaction)!)
      .filter(v => v != null);
  }

  private _getSingleRefInfo(ref: any, transaction: Transaction): InternalAsyncSnapshot<T, R> | null {
    let other = this._singleOtherEnd;
    if (ref) {
      if (!(ref instanceof Reference)) {
        throw new Error('Value is not an instance of Reference. Data must be coerced before updating relations.')
      }

      if (!other) {
        // Find the end which this reference relates to
        other = this.otherEnds.find(({ model }) => model.db.path === ref.parent.path);
        if (!other) {
          throw new StatusError(
            `Reference "${ref.path}" does not refer to any of the available models: ` 
            + this.otherEnds.map(e => `"${e.model.uid}"`).join(', '),
            400,
          );
        }
      }

      return asyncFromRef(other, ref, transaction);
    }
    return null;
  }
}



interface InternalAsyncSnapshot<T extends object, R extends object> extends AsyncSnapshot<R> {
  model: FirestoreConnectorModel<R>

  /**
   * If the snapshot was found by querying, then this is the
   * reference value that was used in the query.
   */
  refValue: Reference<T> | undefined

  /**
   * The attribute info of the other end (referred to by `ref`).
   */
  attr: RelationAttrInfo | undefined
}

function asyncFromSnap<T extends object, R extends object>(info: RelationInfo<R>, snap: Snapshot<R>, wasAtomic: boolean, refValue: Reference<T> | undefined, transaction: Transaction): InternalAsyncSnapshot<T, R> {
  return {
    ...info,
    ref: snap.ref,
    refValue,
    data: async (atomic = false) => {
      const s = (atomic && !wasAtomic)
        ? await transaction.getAtomic(snap.ref)
        : snap;
      const d = s.data();
      if (!d) {
        throw new StatusError(`The document referred to by "${snap.ref.path}" doesn't exist`, 404);
      }
      return d;
    }
  };
}

function asyncFromRef<T extends object, R extends object>(info: RelationInfo<R>, ref: Reference<R>, transaction: Transaction): InternalAsyncSnapshot<T, R> {
  return {
    ...info,
    ref,
    refValue: undefined,
    data: async (atomic = false) => {
      const snap = await (atomic ? transaction.getAtomic(ref) : transaction.getNonAtomic(ref));
      const data = snap.data();
      if (!data) {
        throw new StatusError(`The document referred to by "${ref.path}" doesn't exist`, 404);
      }
      return data;
    },
  };
}
