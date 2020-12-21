import * as path from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import { Firestore, Settings, DocumentReference, Timestamp } from '@google-cloud/firestore';
import { mountModels, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY } from './mount-models';
import { queries } from './queries';
import type { Strapi, FirestoreConnectorContext, StrapiModel, ConnectorOptions } from './types';

/**
 * Firestore hook
 */

const defaults = {
  defaultConnection: 'default',
};

const defaultOptions: ConnectorOptions = {
  useEmulator: false,
  singleId: 'default',
  flattenModels: [],
  allowNonNativeQueries: false,
  ensureCompnentIds: false,

  // Default to 200 because of query size used in admin permissions query
  // https://github.com/strapi/strapi/blob/be4d5556936cf923aa3e23d5da82a6c60a5a42bc/packages/strapi-admin/services/permission.js
  maxQuerySize: 200,
}

const isFirestoreConnection = ({ connector }: StrapiModel) => connector === 'firestore';

module.exports = function(strapi: Strapi) {

  // Patch BigInt to allow JSON serialization
  if (!(BigInt.prototype as any).toJSON) {
    (BigInt.prototype as any).toJSON = function() { return this.toString() };
  }

  // Allow some types to be serialised in JSON responses
  (DocumentReference.prototype as any).toJSON = function() { return this.path; };
  (Timestamp.prototype as any).toJSON = function() { return this.toDate().toJSON(); };


  function initialize() {
    const { connections } = strapi.config;

    for (const [connectionName, connection] of Object.entries(connections)) {
      if (!isFirestoreConnection(connection)) {
        continue;
      }

      _.defaults(connection.settings, strapi.config.hook.settings.firestore);
        const options: ConnectorOptions = _.defaults(connection.options, defaultOptions);

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

        const instance = new Firestore(settings);

        const initFunctionPath = path.resolve(
          strapi.config.appPath,
          'config',
          'functions',
          'firebase.js'
        );

        if (fs.existsSync(initFunctionPath)) {
          require(initFunctionPath)(instance, connection);
        }

        _.set(strapi, `connections.${connectionName}`, instance);


        const ctx = {
          instance,
          connection,
          strapi,
          options
        };
        
        function parseModels(models: Record<string, StrapiModel>, opts?: Partial<FirestoreConnectorContext>): ( FirestoreConnectorContext)[] {
          return Object.entries(models).map(([modelKey, connection]) => ({ ...ctx, modelKey, connection, ...opts }));
        }

        const allModels: FirestoreConnectorContext[] = [
          ...parseModels(strapi.components, { isComponent: true }),
          ...parseModels(strapi.models),
          ...Object.values(strapi.plugins).flatMap(({ models }) => parseModels(models)),
          ...parseModels(strapi.admin.models)
        ];

        mountModels(allModels);
    }
  }

  return {
    defaults,
    initialize, 
    queries, 

    get defaultTimestamps() {
      return [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY];
    },
  };
};
