import type { Firestore, DocumentData } from '@google-cloud/firestore';
import type { QueryableCollection, Reference } from './utils/queryable-collection';
import type { TransactionWrapper } from './utils/transaction-wrapper';

export interface ConnectorOptions {
  useEmulator?: boolean
  singleId: string

  /**
   * Indicate which models to flatten by RegEx. Matches against the
   * model's `uid` property.
   * 
   * Defaults to `[{ test: /^strapi::/, doc: ({ uid }) => uid.replace('::', '/') }]` so that internal Strapi models
   * are flattened into a single collection called `"strapi"`.
   */
  flattenModels: (string | RegExp | { test: string | RegExp, doc?: (model: StrapiModel) => string })[]

  /**
   * Globally allow queries that are not Firestore native.
   * These are implemented manually and will have poor performance,
   * and potentially expensive resource usage.
   */
  allowNonNativeQueries: boolean
}

export interface ModelOptions {
  timestamps?: boolean | [string, string]
  singleId?: string

  /**
   * Override connector flattening options per model.
   * `false` to disable.
   * `true` to enable and use connector's `singleId` for the doucment ID.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  flatten?: boolean


  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  allowNonNativeQueries?: boolean

}

declare global {
  const strapi: Strapi
}

export interface Strapi {
  config: {
    connections: Record<string, any>
    hook: any
    appPath: string
  }
  components: Record<string, FirestoreConnectorModel>
  models: Record<string, FirestoreConnectorModel>
  admin: StrapiPlugin
  plugins: Record<string, StrapiPlugin>
  db: any

  getModel(ref, source): FirestoreConnectorModel

  query(modelKey: string): StrapiQuery
}

export interface StrapiPlugin {
  models: Record<string, FirestoreConnectorModel>
}

export interface StrapiQuery {
  find(params: any): Promise<any[]>
  findOne(params: any): Promise<any>
  create(params: any, values: any): Promise<any>
  update(params: any, values: any): Promise<any>
  delete(params: any): Promise<any>
  count(params: any): Promise<number>
  search(params: any): Promise<any[]>
  countSearch(params: any): Promise<number>
}

export interface StrapiQueryParams {
  model: FirestoreConnectorModel
  modelKey: string
  strapi: Strapi
}

export interface StrapiModel {
  connector: string
  connection: string
  primaryKey: string
  primaryKeyType: string
  attributes: Record<string, StrapiRelation>
  collectionName: string
  kind: 'collectionType' | 'singleType'
  globalId: string
  modelName: string
  uid: string
  orm: string
  options: {
    timestamps?: boolean | [string, string]
  }
  associations: StrapiAssociation[]
}

export type StrapiRelationType = 'oneWay' | 'manyWay' | 'oneToMany' | 'oneToOne' | 'manyToMany' | 'manyToOne' | 'oneToManyMorph' | 'manyToManyMorph' | 'manyMorphToMany' | 'manyMorphToOne' | 'oneMorphToOne' | 'oneMorphToMany';

export interface StrapiRelation {
  dominant: boolean
  via: string
  model: string
  collection: string
  filter: string
  plugin: string
  autoPopulate: boolean
  type: string
  required: boolean
  component: string
  components: string[]
  repeatable: boolean
  min: number
  max: number
}

export interface StrapiAssociation extends StrapiRelation {
  alias: string
  nature: StrapiRelationType
}

export interface StrapiFilter {
  sort?: { field: string, order: 'asc' | 'desc'  }[]
  start?: number,
  limit?: number,
  where?: StrapiWhereFilter[]
}

export type StrapiWhereOperator = 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'ncontains' | 'containss' | 'ncontainss' | 'lt' | 'lte' | 'gt' | 'gte' | 'null';

export interface StrapiWhereFilter {
  field: string
  operator: StrapiWhereOperator
  value: any
}

export interface FirestoreConnectorContext {
  instance: Firestore
  strapi: Strapi
  connection: StrapiModel,
  modelKey: string
  options: ConnectorOptions
  isComponent?: boolean
}

export interface FirestoreConnectorModel extends StrapiModel {
  firestore: Firestore;
  db: QueryableCollection;

  doc(): Reference;
  doc(id: string): Reference;
  create(ref: Reference, data: DocumentData, transaction: TransactionWrapper | undefined): Promise<void>;
  update(ref: Reference, data: DocumentData, transaction: TransactionWrapper | undefined): Promise<void>;
  setMerge(ref: Reference, data: DocumentData, transaction: TransactionWrapper | undefined): Promise<void>;
  delete(ref: Reference, transaction: TransactionWrapper): Promise<void>;

  assocKeys: string[];
  componentKeys: string[];
  idKeys: string[];
  excludedKeys: string[];
  defaultPopulate: string[];
  options: ModelOptions

  /**
   * Set of relations on other models that relate to this
   * model with `oneWay` and `manyWay` relations.
   * We take note of them here because we will need to search and update
   * these relations when items in this model are deleted.
   */
  relatedNonDominantAttrs: { key: string, attr: StrapiRelation, modelKey: string }[]
  
  hasPK: (obj: any) => boolean;
  getPK: (obj: any) => string;
  pickRelations: (obj: any) => any;
  omitExernalValues: (obj: any) => any;
}
