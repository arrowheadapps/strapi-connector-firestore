'use strict';

/**
 * Module dependencies
 */

// Public node modules.
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const firebase = require('firebase-admin');

const relations = require('./relations');
const buildQuery = require('./buildQuery');
const mountModels = require('./mount-models');
const queries = require('./queries');

/**
 * Firestore hook
 */

const defaults = {
  defaultConnection: 'default',
};

const isFirestoreConnection = ({ connector }) => connector === 'firestore';

module.exports = function(strapi) {
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

        const ctx = {
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

  function mountComponents(connectionName, ctx) {
    const options = {
      models: _.pickBy(strapi.components, ({ connection }) => connection === connectionName),
      target: strapi.components,
    };

    return mountModels(options, ctx);
  }

  function mountApis(connectionName, ctx) {
    const options = {
      models: _.pickBy(strapi.models, ({ connection }) => connection === connectionName),
      target: strapi.models,
    };

    return mountModels(options, ctx);
  }

  function mountAdmin(connectionName, ctx) {
    const options = {
      models: _.pickBy(strapi.admin.models, ({ connection }) => connection === connectionName),
      target: strapi.admin.models,
    };

    return mountModels(options, ctx);
  }

  function mountPlugins(connectionName, ctx) {
    return Promise.all(
      Object.keys(strapi.plugins).map(name => {
        const plugin = strapi.plugins[name];
        return mountModels(
          {
            models: _.pickBy(plugin.models, ({ connection }) => connection === connectionName),
            target: plugin.models,
          },
          ctx
        );
      })
    );
  }

  return {
    defaults,
    //...relations,
    buildQuery,

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
