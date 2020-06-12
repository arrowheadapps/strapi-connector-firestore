import type { firestore } from 'firebase-admin';

declare global {
  const strapi: Strapi
}

export interface Strapi {
  config: any
  components: Record<string, FirestoreConnectorModel>
  models: Record<string, FirestoreConnectorModel>
  admin: {
    models: Record<string, FirestoreConnectorModel>
  }
  plugins: Record<string, { models: Record<string, FirestoreConnectorModel> }>

  query(modelKey: string): StrapiQuery
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

export interface FirestoreConnectorContext {
  instance: firestore.Firestore
  strapi: Strapi
  connection: StrapiModel
}

export interface FirestoreConnectorModel extends firestore.CollectionReference, StrapiModel {
  _attributes: Record<string, any>
  associations: any[]
}
