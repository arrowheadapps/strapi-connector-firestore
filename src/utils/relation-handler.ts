import * as _ from 'lodash';
import { FieldValue } from '@google-cloud/firestore';
import { Reference, ReferenceShape, Snapshot, refEquals } from './queryable-collection';
import type { FirestoreConnectorModel } from '../model';
import type { Transaction } from './transaction';
import { coerceToReference, coerceToReferenceShape } from './coerce';
import { StatusError } from './status-error';
import { MorphReference } from './morph-reference';


export interface AsyncSnapshot<R extends object> {
  ref: Reference<R>

  /**
   * Returns a `Promise` that resolves with the document data
   * or rejects if the document referred to by `ref` doesn't exist.
   */
  data(): Promise<R>
}


export interface RelationInfo<T extends object> {
  model: FirestoreConnectorModel<T>
  attr: RelationAttrInfo | undefined
}

export interface RelationAttrInfo {
  alias: string
  isArray: boolean
  filter: string | undefined
  isMorph: boolean
}

export class RelationHandler<T extends object, R extends object = object> {

  constructor(
    private readonly thisEnd: RelationInfo<T>,
    private readonly otherEnds: RelationInfo<R>[],
  ) {
    if (!thisEnd.attr && !otherEnds.filter(e => e.attr).length) {
      throw new Error('Relation does not have any dominant ends defined');
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
      return this._getRefInfo(data, attr)
        .map(r => asyncFromRef(r.attr, r.ref, transaction));
    } else {
      return await this._queryRelated(ref, transaction, false);
    }
  }


  /**
   * Updates the the related models on the given object.
   */
  async update(ref: Reference<T>, prevData: T | undefined, newData: T | undefined, transaction: Transaction): Promise<void> {
    const { attr: thisAttr } = this.thisEnd;
    if (thisAttr) {
      // This end is dominant
      // So we know all the other ends directly without querying

      const prevValues = this._getRefInfo(prevData, thisAttr);
      const newValues = this._getRefInfo(newData, thisAttr);

      // Set the value stored in this document appropriately
      this._setThis(newData, thisAttr, newValues.map(v => this._makeRefToOther(v.ref, thisAttr)));

      // Set the value stored in the references documents appropriately
      const removed = _.differenceWith(prevValues, newValues, refInfoEquals);
      const added = _.differenceWith(newValues, prevValues, refInfoEquals);
      added.forEach(r => {
        this._setRelated(r, ref, true, transaction);
      });
      removed.forEach(r => {
        this._setRelated(r, ref, false, transaction);
      });

    } else {
      // I.e. thisAttr == null (meaning this end isn't dominant)

      if (!newData) {
        // This end is being deleted and it is not dominant
        // so we need to search for the dangling references existing on other models
        const related = await this._queryRelated(ref, transaction, true);
        related.forEach(r => {
          this._setRelated(r, ref, false, transaction);
        });

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
      const values = related
        .map(async snap => {
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
        .filter(d => d != null);

      // The values will be correctly coerced
      // into and array or single value by the method below
      this._setThis(data, attr, await Promise.all(values));
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
   * @param attr Attribute info of the other end (which refers to this)
   */
  private _makeRefToThis(ref: Reference<T>, { isMorph }: RelationAttrInfo): ReferenceShape<T> {
    if (isMorph && !(ref instanceof MorphReference)) {
      throw new Error('TODO: Morph references not implemented yet');
      // return new MorphReference(ref, 'TODO');
    } else {
      return coerceToReferenceShape(ref);
    }
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
        throw new Error('TODO: Morph references not implemented yet');
        // return new MorphReference(ref, 'TODO');
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

  private _setRelated({ ref, attr }: RefInfo<R>, thisRef: Reference<T>, set: boolean, transaction: Transaction) {
    if (attr) {
      const refValue = this._makeRefToThis(thisRef, attr);
      const reverseValue = set
        ? (attr.isArray ? FieldValue.arrayUnion(refValue) : refValue)
        : (attr.isArray ? FieldValue.arrayRemove(refValue) : null);
  
      transaction.update(ref, { [attr.alias]: reverseValue } as object);
    }
  }

  private async _queryRelated(ref: Reference<T>, transaction: Transaction, atomic: boolean): Promise<InternalAsyncSnapshot<T, R>[]> {
    const snaps = this.otherEnds.map(async ({ model, attr }) => {
      if (attr) {
        const refShape = this._makeRefToThis(ref, attr);
        let q = attr.isArray
          ? model.db.where(attr.alias, 'array-contains', refShape)
          : model.db.where(attr.alias, '==', refShape);
        if (model.options.maxQuerySize) {
          q = q.limit(model.options.maxQuerySize);
        }
        const snap = atomic
          ? await transaction.getAtomic(q)
          : await transaction.getNonAtomic(q);
        return snap.docs.map(d => asyncFromSnap(attr, d, refShape));
      } else {
        return [];
      }
    });
    return (await Promise.all(snaps)).flat();
  }

  private _getRefInfo(data: T | undefined, thisAttr: RelationAttrInfo): RefInfo<R>[] {
    return _.castArray(_.get(data, thisAttr.alias) || [])
      .map(v => this._getSingleRefInfo(v)!)
      .filter(v => v != null);
  }

  private _getSingleRefInfo(value: any): RefInfo<R> | null {
    let other = this._singleOtherEnd;
    const ref = coerceToReference(value, other?.model, true);

    if (ref) {
      if (!other) {
        // Find the end which this reference relates to
        other = this.otherEnds.find(({ model }) => model.db.path === ref.parent.path);
        if (!other) {
          throw new Error(
            `Reference "${ref.path}" does not refer to any of the available models: ` 
            + this.otherEnds.map(e => `"${e.model.modelName}"`).join(', ')
          );
        }
      }

      return {
        ...other,
        ref,
      };
    }
    return null;
  }
}



interface RefInfo<R extends object> {
  ref: Reference<R>
  attr: RelationAttrInfo | undefined
}

interface InternalAsyncSnapshot<T extends object, R extends object> extends AsyncSnapshot<R> {
  /**
   * If the snapshot was found by querying, then this is the
   * `ReferenceShape` that was used in the query.
   */
  refShape: ReferenceShape<T> | undefined

  /**
   * The attribute info of the other end (referred to by `ref`).
   */
  attr: RelationAttrInfo | undefined
}

function asyncFromSnap<T extends object, R extends object>(attr: RelationAttrInfo, snap: Snapshot<R>, refShape: ReferenceShape<T> | undefined): InternalAsyncSnapshot<T, R> {
  return {
    attr,
    ref: snap.ref,
    refShape,
    data: () => {
      const d = snap.data();
      if (!d) {
        throw new StatusError(`The document referred to by "${snap.ref.path}" doesn't exist`, 404);
      }
      return Promise.resolve(d);
    }
  };
}

function asyncFromRef<T extends object, R extends object>(attr: RelationAttrInfo | undefined, ref: Reference<R>, transaction: Transaction | undefined): InternalAsyncSnapshot<T, R> {
  return {
    attr,
    ref,
    refShape: undefined,
    data: async () => {
      const snap = await (transaction ? transaction.getNonAtomic(ref) : ref.get());
      const data = snap.data();
      if (!data) {
        throw new StatusError(`The document referred to by "${ref.path}" doesn't exist`, 404);
      }
      return data;
    },
  };
}

function refInfoEquals(a: RefInfo<any>, b: RefInfo<any>): boolean {
  return refEquals(a.ref, b.ref);
}

