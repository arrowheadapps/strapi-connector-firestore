import type { Firestore, CollectionReference } from '@google-cloud/firestore';

declare global {
  const strapi: Strapi
}

export interface Strapi {
  config: any
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
  attributes: Record<string, any>
  collectionName: string
  globalId: string
  orm: string
  options: {
    timestamps: boolean | [string, string]
  }
}

export interface StrapiFilter {
  sort?: { field: string, order: 'asc' | 'desc'  }[]
  start?: number,
  limit?: number,
  where?: StrapiWhereFilter[]
}

export interface StrapiWhereFilter {
  field: string
  operator: 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'ncontains' | 'containss' | 'ncontainss' | 'lt' | 'lte' | 'gt' | 'gte' | 'null'
  value: any
}

export interface FirestoreConnectorContext {
  instance: Firestore
  strapi: Strapi
  connection: StrapiModel
}

export type FirestoreConnectorModel = CollectionReference & StrapiModel & {
  _attributes: Record<string, any>
  associations: any[]
}
