import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import { Firestore, Settings, DocumentReference, Timestamp } from '@google-cloud/firestore';
import { allModels, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY, mountModels } from './model';
import { queries } from './queries';
import type { Strapi, ConnectorOptions } from './types';
import { FlatCollection } from './db/flat-collection';

export type { 
  Strapi,
  Connector,
  ConnectorOptions,
  ModelOptions,
  Converter,
  StrapiQuery,
  IndexerFn,
  FlattenFn,
  ModelTestFn,
} from './types';
export type {
  Reference,
  Snapshot
} from './db/reference';
export type { 
  Queryable,
  Collection,
  QuerySnapshot, 
} from './db/collection';
export type { FirestoreConnectorModel } from './model';
export type { Transaction } from './db/transaction';
export type {
  PopulatedByKeys,
  PickReferenceKeys,
} from './populate';



const defaults = {
  defaultConnection: 'default',
};

const defaultOptions: Required<ConnectorOptions> = {
  useEmulator: false,
  singleId: 'default',
  flattenModels: [],
  allowNonNativeQueries: false,
  ensureComponentIds: true,
  logTransactionStats: process.env.NODE_ENV === 'development',
  logQueries: false,
  metadataField: '$meta',
  creatorUserModel: { model: 'user', plugin: 'admin' },

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
  (DocumentReference.prototype as any).toJSON = function() { return this.id; };
  (Timestamp.prototype as any).toJSON = function() { return this.toDate().toJSON(); };

  const { connections } = strapi.config;
  const firestoreConnections = Object.keys(connections)
    .filter(connectionName => {
      const connection = connections[connectionName];
      if (connection.connector !== 'firestore') {
        strapi.log.warn(
          'You are using the Firestore connector alongside ' +
          'other connector types. The Firestore connector is not ' +
          'designed for this, so you will likely run into problems.'
        );
        return false;
      } else {
        return true;
      }
    });


  const initialize = async () => {
    await Promise.all(
      firestoreConnections.map(async connectionName => {
        const connection = connections[connectionName];

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
        _.set(strapi, `connections.${connectionName}`, firestore);

        const initFunctionPath = path.resolve(
          strapi.config.appPath,
          'config',
          'functions',
          'firebase.js'
        );

        if (await fs.pathExists(initFunctionPath)) {
          require(initFunctionPath)(firestore, connection);
        }

        // Mount all models
        mountModels({
          strapi,
          firestore,
          connectorOptions: options,
        });

        // Initialise all flat collections
        // We do it here rather than lazily, otherwise the write which
        // ensures the existence will contend with the transaction that
        // operates on the document
        // In the Firestore production server this resolves and retries
        // but in the emulator it results in deadlock
        const tasks: Promise<void>[] = [];
        for (const { model: { db } } of allModels()) {
          if (db instanceof FlatCollection) {
            tasks.push(db.ensureDocument());
          }
        }
        await Promise.all(tasks);
      })
    );
  };

  const destroy = async () => {
    await Promise.all(
      firestoreConnections.map(async connectionName => {
        const firestore = strapi.connections[connectionName];
        if (firestore instanceof Firestore) {
          await firestore.terminate();
        }
      })
    );
  };

  return {
    defaults,
    initialize,
    destroy, 
    queries, 
    defaultTimestamps: [DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY],
  };
};
