import * as path from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import { Firestore, Settings } from '@google-cloud/firestore';

import { mountModels, DEFAULT_CREATE_TIME_KEY, DEFAULT_UPDATE_TIME_KEY } from './mount-models';
import { queries } from './queries';
import { Strapi, FirestoreConnectorContext, StrapiModel, Options } from './types';

/**
 * Firestore hook
 */

const defaults = {
  defaultConnection: 'default',
};

const defaultOptions: Options = {
  useEmulator: false,
  singleId: 'default',
}

const isFirestoreConnection = ({ connector }: StrapiModel) => connector === 'firestore';

module.exports = function(strapi: Strapi) {
  function initialize() {
    const { connections } = strapi.config;

    const connectionsPromises = Object.keys(connections)
      .filter(key => isFirestoreConnection(connections[key]))
      .map(async connectionName => {
        const connection = connections[connectionName];

        _.defaults(connection.settings, strapi.config.hook.settings.firestore);
        const options: Options = _.defaults(connection.options, defaultOptions);

        const settings: Settings = {
          ignoreUndefinedProperties: true,
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

        const ctx: FirestoreConnectorContext = {
          instance,
          connection,
          strapi,
          options
        };

        _.set(strapi, `connections.${connectionName}`, instance);

        return Promise.all([
          mountComponents(connectionName, ctx),
          mountApis(connectionName, ctx),
          mountAdmin(connectionName, ctx),
          mountPlugins(connectionName, ctx),
        ]);
      });

    return Promise.all(connectionsPromises);
  }

  function mountComponents(connectionName: string, ctx: FirestoreConnectorContext) {
    return mountModels(
      _.pickBy(strapi.components, ({ connection }) => connection === connectionName), 
      strapi.components, 
      ctx
    );
  }

  function mountApis(connectionName: string, ctx: FirestoreConnectorContext) {
    return mountModels(
      _.pickBy(strapi.models, ({ connection }) => connection === connectionName),
      strapi.models,
      ctx
    );
  }

  function mountAdmin(connectionName: string, ctx: FirestoreConnectorContext) {
    return mountModels(
      _.pickBy(strapi.admin.models, ({ connection }) => connection === connectionName),
      strapi.admin.models,
      ctx
    );
  }

  function mountPlugins(connectionName: string, ctx: FirestoreConnectorContext) {
    return Promise.all(
      Object.keys(strapi.plugins).map(name => {
        const plugin = strapi.plugins[name];
        return mountModels(
          _.pickBy(plugin.models, ({ connection }) => connection === connectionName),
          plugin.models,
          ctx
        );
      })
    );
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
