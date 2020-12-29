import * as path from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import { Firestore, Settings, DocumentReference, Timestamp } from '@google-cloud/firestore';
import { FirestoreConnectorModel, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY } from './model';
import { FirestoreConnectorQuery } from './query';
import type { Strapi, StrapiModel, ConnectorOptions, StrapiContext } from './types';

export type { 
  Strapi,
  Connector,
  ConnectorOptions,
  ModelOptions,
  ModelConfig,
  Converter,
  StrapiQuery,
} from './types';
export type { 
  Queryable,
  QueryableCollection,
  QuerySnapshot,
  Reference 
} from './utils/queryable-collection';
export type { FirestoreConnectorModel } from './model';
export type { Transaction } from './utils/transaction';


const defaults = {
  defaultConnection: 'default',
};

const defaultOptions: Required<ConnectorOptions> = {
  useEmulator: false,
  singleId: 'default',
  flattenModels: [],
  allowNonNativeQueries: false,
  ensureCompnentIds: false,

  // Default to 200 because of query size used in admin permissions query
  // https://github.com/strapi/strapi/blob/be4d5556936cf923aa3e23d5da82a6c60a5a42bc/packages/strapi-admin/services/permission.js
  maxQuerySize: 200,
}

module.exports = (strapi: Strapi) => {

  // Patch BigInt to allow JSON serialization
  if (!(BigInt.prototype as any).toJSON) {
    (BigInt.prototype as any).toJSON = function() { return this.toString() };
  }

  // Patch Firestore types to allow JSON serialization
  (DocumentReference.prototype as any).toJSON = function() { return this.path; };
  (Timestamp.prototype as any).toJSON = function() { return this.toDate().toJSON(); };


  const initialize = async () => {
    const { connections } = strapi.config;
    await Promise.all(
      Object.keys(connections).map(async connectionName => {
        const connection = connections[connectionName];
        if (connection.connector !== 'firestore') {
          strapi.log.warn(
            'You are using the Firestore connector alongside ' +
            'other connector types. The Firestore connector is not ' +
            'designed for this, so you will likely run into problems.'
          );
          return;
        }

        _.defaults(connection.settings, strapi.config.hook.settings.firestore);
        const options = _.defaults(connection.options, defaultOptions);

        const settings: Settings = {
          ignoreUndefinedProperties: true,
          useBigInt: true,
          ...connection.settings,
        };

        if (options.useEmulator) {
          // Direct the Firestore instance to connect to a local emulator
          Object.assign(settings, {
            port: 8080,
            host: 'localhost',
            sslCreds: require('@grpc/grpc-js').credentials.createInsecure(),
            customHeaders: {
              "Authorization": "Bearer owner"
            },
          });
        }

        const firestore = new Firestore(settings);

        const initFunctionPath = path.resolve(
          strapi.config.appPath,
          'config',
          'functions',
          'firebase.js'
        );

        if (await fs.promises.access(initFunctionPath).then(() => true, () => false)) {
          require(initFunctionPath)(firestore, connection);
        }
        
        const mountModels = (models: Record<string, StrapiModel>, isComponent: boolean = false) => {
          Object.keys(models).forEach(modelKey => {
            const model = new FirestoreConnectorModel({
              firestore,
              modelKey,
              model: models[modelKey],
              options,
              isComponent,
            });

            // FIXME:
            // We are trying to replace every instance of the model
            // This will break easily as references to the model may be
            // stored in other places in future versions
            models[modelKey] = model;
            strapi.contentTypes[model.uid] = model;
          });
        }

        mountModels(strapi.models);
        mountModels(strapi.admin.models);
        mountModels(strapi.components, true);

        Object.values(strapi.plugins).forEach(plugin => {
          mountModels(plugin.models);
        });
      })
    );
  }

  const queries = (args: StrapiContext) => {
    return new FirestoreConnectorQuery(args);
  };

  return {
    defaults,
    initialize, 
    queries, 
    defaultTimestamps: [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY],
  };
};
