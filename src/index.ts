import * as path from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import * as firebase from 'firebase-admin';

import { mountModels } from './mount-models';
import { queries } from './queries';
import { Strapi, FirestoreConnectorContext, StrapiModel } from './types';

/**
 * Firestore hook
 */

const defaults = {
  defaultConnection: 'default',
};

const isFirestoreConnection = ({ connector }: StrapiModel) => connector === 'firestore';

module.exports = function(strapi: Strapi) {
  function initialize() {
    const { connections } = strapi.config;

    const connectionsPromises = Object.keys(connections)
      .filter(key => isFirestoreConnection(connections[key]))
      .map(async connectionName => {
        const connection = connections[connectionName];

        _.defaults(connection.settings, strapi.config.hook.settings.firestore);


        firebase.initializeApp(connection.settings);
        const instance = firebase.firestore();

        if (connection.options.useEmulator) {
          instance.settings({
            ignoreUndefinedProperties: true,
            port: 8080,
            host: 'localhost',
            customHeaders: {
              "Authorization": "Bearer owner"
            },
            sslCreds: require('@grpc/grpc-js').credentials.createInsecure()
          });
        } else {
          instance.settings({
            ignoreUndefinedProperties: true,
          });
        }

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
          strapi
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
    //...relations,
    //buildQuery,

    // Used by connector-registry.js
    initialize, 

    // Used by database-manager.js @ query() L84
    // Then by create-query.js (just a wrapper adding lifecycle callbacks)
    queries, 

    // Used by database-manager.js
    // Used by check-reserved-named.js
    get defaultTimestamps() {
      return ['_createTime', '_updateTime'];
    },
  };
};
