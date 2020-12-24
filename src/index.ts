import * as path from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import { Firestore, Settings, DocumentReference, Timestamp } from '@google-cloud/firestore';
import { FirestoreConnectorModel, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY } from './model';
import { queries } from './queries';
import type { Strapi, StrapiModel, ConnectorOptions } from './types';


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

module.exports = (strapi: Strapi) => {

  // Patch BigInt to allow JSON serialization
  if (!(BigInt.prototype as any).toJSON) {
    (BigInt.prototype as any).toJSON = function() { return this.toString() };
  }

  // Patch Firestore types to allow JSON serialization
  (DocumentReference.prototype as any).toJSON = function() { return this.path; };
  (Timestamp.prototype as any).toJSON = function() { return this.toDate().toJSON(); };


  const initialize = () => {
    const { connections } = strapi.config;

    for (const [connectionName, connection] of Object.entries(connections)) {
      if (!isFirestoreConnection(connection)) {
        strapi.log.warn(
          'You are using the Firestore connector alongside ' +
          'other connector types. The Firestore connector is not' +
          'designed for this, so you will likely run into problems.'
        );
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

      const firestore = new Firestore(settings);
      _.set(strapi, `connections.${connectionName}`, firestore);

      const initFunctionPath = path.resolve(
        strapi.config.appPath,
        'config',
        'functions',
        'firebase.js'
      );

      if (fs.existsSync(initFunctionPath)) {
        require(initFunctionPath)(firestore, connection);
      }
      
      const mountModels = (models: Record<string, StrapiModel>, isComponent: boolean = false) => {
        Object.keys(models).forEach(modelKey => {
          models[modelKey] = new FirestoreConnectorModel({
            firestore,
            modelKey,
            options,
            connection,
            isComponent,
          });
        });
      }

      mountModels(strapi.models);
      mountModels(strapi.admin.models);
      mountModels(strapi.components, true);

      Object.values(strapi.plugins).forEach(plugin => {
        mountModels(plugin.models);
      });
    }
  }

  return {
    defaults,
    initialize, 
    queries, 
    defaultTimestamps: [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY],
  };
};
