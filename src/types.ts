import type { DocumentReference, Settings } from '@google-cloud/firestore';
import type { ModelBase, ModelData } from 'strapi';
 

declare module 'strapi' {

  interface ConnectorSettings extends Settings {

  }

  interface ConnectorOptions {

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

  interface Attribute {
    index?: boolean
    indexAs?: string | { [key: string]: true | IndexerFn }
    isMeta?: boolean
  }
}

export interface IndexerFn {
  (value: any, component: object): any
}

export interface FlattenFn<T extends ModelData = any> {
  (model: ModelBase<T>): string | boolean | DocumentReference | null | undefined
}

export interface ModelTestFn<T extends ModelData = any> {
  (model: ModelBase<T>): boolean
}

