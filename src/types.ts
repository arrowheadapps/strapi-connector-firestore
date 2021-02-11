import type { DocumentData, DocumentReference, FieldPath, Settings, WhereFilterOp } from '@google-cloud/firestore';
import type { Logger } from 'pino';
import type { FirestoreConnectorModel } from './model';

export interface Connector {
  connector: string
  options: ConnectorOptions
  settings?: Settings
}

export interface ConnectorOptions {

  /**
   * Indicates whether to connect to a locally running
   * Firestore emulator instance.
   * 
   * Defaults to `false`.
   */
  useEmulator?: boolean

  /**
   * Indicates whether or not to log the number of
   * read and write operations for every transaction
   * that is executed.
   * 
   * Defaults to `true` for development environments
   * and `false` otherwise.
   */
  logTransactionStats?: boolean

  /**
   * Indicates whether or not to log the details of
   * every query that is executed.
   * 
   * Defaults to `false`.
   */
  logQueries?: boolean

  /**
   * Designates the document ID to use to store the data
   * for "singleType" models, or when flattening is enabled.
   * 
   * Defaults to `"default"`.
   */
  singleId?: string

  /**
   * Indicate which models to flatten by RegEx. Matches against the
   * model's `uid` property.
   * 
   * Defaults to `false` so that no models are flattened.
   */
  flattenModels?: boolean | string | RegExp | FlattenFn | (string | RegExp | FlattenFn)[]

  /**
   * Globally allow queries that are not Firestore native.
   * These are implemented manually and will have poor performance,
   * and potentially expensive resource usage.
   * 
   * Defaults to `false`.
   */
  allowNonNativeQueries?: boolean | string | RegExp | ModelTestFn | (string | RegExp | ModelTestFn)[]

  /**
   * If `true`, then IDs are automatically generated and assigned
   * to embedded components (incl. dynamic zone).
   * 
   * Defaults to `true`.
   */
  ensureComponentIds?: boolean

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

  /**
   * The field used to build the field that will store the
   * metadata map which holds the indexes for repeatable and
   * dynamic-zone components.
   * 
   * If it is a string, then it will be combined with the component
   * field as a postfix. If it is a function, then it will be called
   * with the field of the attribute containing component, and the function
   * must return the string to be used as the field.
   * 
   * Defaults to `"$meta"`.
   */
  metadataField?: string | ((attrKey: string) => string)
}

export interface ModelOptions<T extends object, R extends object = any> {
  timestamps?: boolean | [string, string]
  singleId?: string

  /**
   * Override connector option per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  logQueries?: boolean

  /**
   * Override connector flattening options per model.
   * `false` to disable.
   * `true` to enable and use connector's `singleId` for the document ID.
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
   * If defined, nominates a single attribute to be searched when fully-featured
   * search is disabled because of the `allowNonNativeQueries` setting.
   */
  searchAttribute?: string

  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  ensureComponentIds?: boolean

  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  maxQuerySize?: number

  /**
   * Override connector setting per model.
   * 
   * Defaults to `undefined` (use connector setting).
   */
  metadataField?: string | ((attrKey: AttributeKey<T>) => string)

  /**
   * Converter that is run upon data immediately before it
   * is stored in Firestore, and immediately after it is
   * retrieved from Firestore.
   */
  converter?: Converter<T, R>
}

export interface Converter<T, R = DocumentData> {
  toFirestore?: (data: Partial<T>) => R
  fromFirestore?: (data: R) => T
}

declare global {
  const strapi: Strapi

  interface StrapiModelMap {

  }
}

export interface StrapiContext<T extends object = object> {
  strapi: Strapi
  modelKey: string
  model: FirestoreConnectorModel<T>
}

export interface Strapi {
  config: {
    connections: { [c: string]: Connector }
    hook: any
    appPath: string
  }
  components: StrapiModelRecord
  models: StrapiModelRecord
  contentTypes: { [key: string]: StrapiModel }
  admin: Readonly<StrapiPlugin>
  plugins: { [key: string]: Readonly<StrapiPlugin> }
  db: StrapiDatabaseManager
  connections: { [name: string]: any }
  log: Logger

  getModel(modelKey: string, plugin?: string): Readonly<FirestoreConnectorModel>

  query<K extends keyof StrapiModelMap>(entity: K, plugin?: string): StrapiQuery<StrapiModelMap[K]>
  query(entity: string, plugin?: string): StrapiQuery
}

export type StrapiModelRecord = {
  [modelKey in keyof StrapiModelMap]: Readonly<FirestoreConnectorModel<StrapiModelMap[modelKey]>>
};

export interface StrapiDatabaseManager {
  getModel(name: string, plugin: string | undefined): FirestoreConnectorModel<any> | undefined
  getModelByAssoc(assoc: StrapiAttribute): FirestoreConnectorModel<any> | undefined
  getModelByCollectionName(collectionName: string): FirestoreConnectorModel<any> | undefined
  getModelByGlobalId(globalId: string): FirestoreConnectorModel<any> | undefined
}

export interface StrapiPlugin {
  models: StrapiModelRecord
}


export type AttributeKey<T extends object> = Extract<keyof T, string>;

export interface StrapiQuery<T extends object = DocumentData> {
  model: StrapiModel<T>
  find(params?: any, populate?: AttributeKey<T>[]): Promise<T[]>
  findOne(params?: any, populate?: AttributeKey<T>[]): Promise<T | null>
  create(values: T, populate?: AttributeKey<T>[]): Promise<T>
  update(params: any, values: T, populate?: AttributeKey<T>[]): Promise<T>
  delete(params: any, populate?: AttributeKey<T>[]): Promise<(T | null) | (T | null)[]>
  count(params?: any): Promise<number>
  search(params: any, populate?: AttributeKey<T>[]): Promise<T[]>
  countSearch(params: any): Promise<number>
  fetchRelationCounters(attribute: AttributeKey<T>, entitiesIds?: string[]): Promise<RelationCounter[]>
}

export interface RelationCounter {
  id: string
  count: number
}

export interface StrapiModel<T extends object = object> {
  connector: string
  connection: string
  primaryKey: string
  primaryKeyType: string
  attributes: { [key: string]: StrapiAttribute }
  privateAttributes: { [key: string]: StrapiAttribute }
  collectionName: string
  kind: 'collectionType' | 'singleType'
  globalId: string
  plugin?: string
  modelName: string
  modelType?: 'contentType' | 'component'
  internal?: boolean
  uid: string
  orm: string
  options: {
    timestamps?: boolean | [string, string]
  }
  associations: StrapiAssociation<AttributeKey<T>>[]
}

export type StrapiRelationType = 'oneWay' | 'manyWay' | 'oneToMany' | 'oneToOne' | 'manyToMany' | 'manyToOne' | 'oneToManyMorph' | 'manyToManyMorph' | 'manyMorphToMany' | 'manyMorphToOne' | 'oneMorphToOne' | 'oneMorphToMany';
export type StrapiAttributeType = 'integer' | 'float' | 'decimal' | 'biginteger' | 'string' | 'text' | 'richtext' | 'email' | 'enumeration' | 'uid' | 'date' | 'time' | 'datetime' | 'timestamp' | 'json' | 'boolean' | 'password' | 'dynamiczone' | 'component';

export interface StrapiAttribute {
  dominant?: boolean
  via?: string
  model?: string
  collection?: string
  filter?: string
  plugin?: string
  autoPopulate?: boolean
  type?: StrapiAttributeType
  required?: boolean
  component?: string
  components?: string[]
  repeatable?: boolean
  min?: number
  max?: number
  private?: boolean
  configurable?: boolean
  writable?: boolean

  index?: true | string | { [key: string]: true | IndexerFn }
  isMeta?: boolean
}

export interface IndexerFn {
  (value: any, component: object): any
}

export interface FlattenFn<T extends object = any> {
  (model: StrapiModel<T>): string | boolean | DocumentReference | null | undefined
}

export interface ModelTestFn<T extends object = any> {
  (model: StrapiModel<T>): boolean
}

export interface StrapiAssociation<K extends string = string> {
  alias: K
  nature: StrapiRelationType
  autoPopulate: boolean

  /**
   * The `uid` of the target model, or `"*"` if this is
   * polymorphic.
   */
  targetUid: string
  type: 'model' | 'collection'
  collection?: string
  model?: string
  dominant?: boolean
  via?: string
  plugin?: string
  filter?: string
  related?: FirestoreConnectorModel<any>[]
  tableCollectionName?: string
}

export interface StrapiFilter {
  sort?: { field: string, order: 'asc' | 'desc'  }[]
  start?: number,
  limit?: number,
  where?: (StrapiWhereFilter | StrapiOrFilter)[]
}

export type StrapiWhereOperator = 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'ncontains' | 'containss' | 'ncontainss' | 'lt' | 'lte' | 'gt' | 'gte' | 'null';

export interface StrapiWhereFilter {
  field: string
  operator: StrapiWhereOperator
  value: any
}

export interface StrapiOrFilter {
  field?: null
  operator: 'or'
  value: StrapiWhereFilter[]
}

export interface FirestoreFilter {
  field: string | FieldPath
  operator: WhereFilterOp
  value: any
}
