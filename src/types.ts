import type { Firestore, DocumentData } from '@google-cloud/firestore';
import type { QueryableCollection, Reference, Snapshot } from './utils/queryable-collection';
import type { TransactionWrapper } from './utils/transaction-wrapper';
import type { Logger } from 'pino';

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
  allowNonNativeQueries: boolean | RegExp

  /**
   * If `true`, then IDs are automatically generated and assigned
   * to embedded components (incl. dynamic zone).
   * 
   * Defults to `false`.
   */
  ensureCompnentIds?: boolean

  /**
   * If defined, enforces a maximum limit on the size of all queries.
   * You can use this to limit out-of-control quota usage.
   * 
   * Does not apply to flattened collections which use only a single
   * read operation anyway.
   * 
   * Defaults to `200`.
   */
  maxQuerySize?: number
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


  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  ensureCompnentIds?: boolean

  

  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  maxQuerySize?: number
}


export interface ModelConfig<T = any, R = any> {

  /**
   * Converter that is run upon data immediately before it
   * is stored in Firestore, and immediately after it is
   * retrieved from Firestore.
   */
  converter?: Converter<T, R>
}

export interface Converter<T, R> {
  toFirestore: (data: Partial<T>) => R
  fromFirestore: (data: R) => Partial<T>
}

declare global {
  const strapi: Strapi

  interface StrapiModelMap {

  }
}

export interface Strapi {
  config: {
    connections: Record<string, any>
    hook: any
    appPath: string
  }
  components: StrapiModelRecord
  models: StrapiModelRecord
  admin: Readonly<StrapiPlugin>
  plugins: Record<string, Readonly<StrapiPlugin>>
  db: StrapiDatabaseManager
  log: Logger

  getModel(modelKey: string, plugin?: string): Readonly<FirestoreConnectorModel>

  query<K extends keyof StrapiModelMap>(entity: K, plugin?: string): StrapiQuery<StrapiModelMap[K]>
  query(entity: string, plugin?: string): StrapiQuery
}

export type StrapiModelRecord = {
  [modelKel in keyof StrapiModelMap]: Readonly<FirestoreConnectorModel<StrapiModelMap[modelKel]>>
};

export interface StrapiDatabaseManager {
  getModel(name: string, plugin: string | undefined): FirestoreConnectorModel | undefined
  getModelByAssoc(assoc: StrapiRelation): FirestoreConnectorModel | undefined
  getModelByCollectionName(collectionName: string): FirestoreConnectorModel | undefined
  getModelByGlobalId(globalId: string): FirestoreConnectorModel | undefined
}

export interface StrapiPlugin {
  models: StrapiModelRecord
}

export interface StrapiQuery<T = DocumentData> {
  find(params?: any, populate?: (keyof T)[]): Promise<T[]>
  findOne(params?: any, populate?: (keyof T)[]): Promise<T>
  create(values: T, populate?: (keyof T)[]): Promise<T>
  update(params: any, values: T, merge?: boolean, populate?: (keyof T)[]): Promise<T>
  delete(params: any, populate?: (keyof T)[]): Promise<T>
  count(params?: any): Promise<number>
  search(params: any, populate?: (keyof T)[]): Promise<T[]>
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
  privateAttributes: Record<string, StrapiRelation>
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

export interface FirestoreConnectorModel<T = DocumentData> extends StrapiModel {
  firestore: Firestore;
  db: QueryableCollection<T>;

  autoId(): string;
  doc(): Reference<T>;
  doc(id: string): Reference<T>;
  create(ref: Reference<T>, data: T, transaction: TransactionWrapper | undefined): Promise<void>;
  update(ref: Reference<T>, data: Partial<T>, transaction: TransactionWrapper | undefined): Promise<void>;
  setMerge(ref: Reference<T>, data: Partial<T>, transaction: TransactionWrapper | undefined): Promise<void>;
  delete(ref: Reference<T>, transaction: TransactionWrapper | undefined): Promise<void>;

  runTransaction<TResult>(fn: (transaction: TransactionWrapper) => Promise<TResult>): Promise<TResult>;

  populate(data: Snapshot<T>, transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<T>
  populateAll(datas: Snapshot<T>[], transaction: TransactionWrapper, populate?: (keyof T)[]): Promise<T[]>

  assocKeys: string[];
  componentKeys: string[];
  idKeys: string[];
  excludedKeys: string[];
  defaultPopulate: string[];
  options: ModelOptions;
  config: ModelConfig<T>

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
