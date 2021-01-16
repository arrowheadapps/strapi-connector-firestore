import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import { Firestore, Settings, DocumentReference, Timestamp } from '@google-cloud/firestore';
import { allModels, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY, mountModels } from './model';
import { queries } from './queries';
import type { Strapi, ConnectorOptions, StrapiModel } from './types';
import { QueryableFlatCollection } from './db/queryable-flat-collection';

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
  QueryableCollection,
  QuerySnapshot, 
} from './db/queryable-collection';
export type { FirestoreConnectorModel } from './model';
export type { Transaction } from './db/transaction';


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


  // HACK: Patch content manager plugin to hide metadata attributes
  // Current Strapi versions do not support hidden or virtual attributes
  // A side-effect of hiding these attributes from the admin
  // is that they are not visible for sorting or filtering
  // Future versions may add virtual attributes but this patch will still be 
  // required for old Strapi versions
  // See: https://github.com/strapi/rfcs/pull/17

  const dataMapperService: any = _.get(strapi.plugins, 'content-manager.services.data-mapper');
  const { toContentManagerModel: _toContentManagerModel } = dataMapperService || {};
  if (!dataMapperService || !_toContentManagerModel) {
    strapi.log.warn(
      'An update to Strapi has broken the patch applied to strapi-plugin-content-manager. ' +
      'Please revert to the previous version.'
    );
  }
  dataMapperService.toContentManagerModel = (...params) => {
    const model: StrapiModel<any> = _toContentManagerModel(...params);
    for (const key of Object.keys(model.attributes)) {
      if (model.attributes[key].isMeta) {
        delete model.attributes[key];
      }
    }
    return model;
  }
  

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
        for (const { db } of allModels()) {
          if (db instanceof QueryableFlatCollection) {
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
