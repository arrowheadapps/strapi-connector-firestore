## ⚠️⚠️ Warning: pre-release ⚠️⚠️

This is package an early work in progress an is not suitable for production in it's current state. Feel free to use it an feedback any issues here:
https://github.com/arrowheadapps/strapi-connector-firestore/issues

The shape of the generated database output may break compatibility often while in "alpha" state.

Known issues/not implemented
- Higher complexity relations such as many-many, components, and polymorphism are untested
- Deep filtering in API queries

I welcome contributors to help get this package to a production ready state and maintain it.

See the discussion in [issue #1](https://github.com/arrowheadapps/strapi-connector-firestore/issues/1).


# strapi-connector-firestore

[![NPM Version](https://img.shields.io/npm/v/strapi-connector-firestore/latest)](https://www.npmjs.org/package/strapi-connector-firestore)
[![Monthly download on NPM](https://img.shields.io/npm/dm/strapi-connector-firestore)](https://www.npmjs.org/package/strapi-connector-firestore)
![Tests](https://github.com/arrowheadapps/strapi-connector-firestore/workflows/Tests/badge.svg)
[![codecov](https://codecov.io/gh/arrowheadapps/strapi-connector-firestore/branch/master/graph/badge.svg)](https://codecov.io/gh/arrowheadapps/strapi-connector-firestore)
[![Snyk Vulnerabilities](https://img.shields.io/snyk/vulnerabilities/npm/strapi-connector-firestore)](https://snyk.io/test/npm/strapi-connector-firestore)
[![GitHub bug issues](https://img.shields.io/github/issues/arrowheadapps/strapi-connector-firestore/bug)](https://github.com/arrowheadapps/strapi-connector-firestore/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/arrowheadapps/strapi-connector-firestore)](https://github.com/arrowheadapps/strapi-connector-firestore)

Strapi database connector for [Cloud Firestore](https://firebase.google.com/docs/firestore) database on Google Cloud Platform.

Cloud Firestore is a flexible, scalable database for mobile, web, and server development from Firebase and Google Cloud Platform.

It has several advantages such as:
- SDKs for Android, iOS, Web, and many others.
- Realtime updates.
- Integration with the suite of mobile and web development that come with Firebase, such as Authentication, Push Notifications, Cloud Functions, etc.
- Generous [free usage tier](https://firebase.google.com/pricing) so there is no up-front cost to get started.

## Requirements

- NodeJS `>= 12`
- Strapi version compatible with `^3.0.0`

## Installation

Install the NPM package:

```
$ npm install --save strapi-connector-firestore
```

Configure Strapi to use the Firestore database connector in `./config/database.js`:

```javascript
// ./config/database.js
module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      settings: {
        projectId: '{YOUR_PROJECT_ID}',
      },
      options: {
        // Connect to a local running Firestore emulator
        // when running in development mode
        useEmulator: env('NODE_ENV') == 'development',
      }
    }
  },
});
```

## Examples

See some example projects:

- [Cloud Run and Firebase Hosting](/examples/cloud-run-and-hosting)


## Usage Instructions

### Connector options

These are the available options to be specified in the Strapi database configuration file: `./config/database.js`.

| Name                    | Type        | Default     | Description                     |
|-------------------------|-------------|-------------|---------------------------------|
| `settings`              | `Object`    | `undefined` | Passed directly to the Firestore constructor. Specify any options described here: https://googleapis.dev/nodejs/firestore/latest/Firestore.html#Firestore. You can omit this completely on platforms that support [Application Default Credentials](https://cloud.google.com/docs/authentication/production#finding_credentials_automatically) such as Cloud Run, and App Engine. If you want to test locally using a local emulator, you need to at least specify the `projectId`. |
| `options.useEmulator`   | `string`    | `false`     | Connect to a local Firestore emulator instead of the production database. You must start a local emulator yourself using `firebase emulators:start --only firestore` before you start Strapi. See https://firebase.google.com/docs/emulator-suite/install_and_configure. |
| `options.singleId`      | `string`    | `"default"` | The document ID to used for `singleType` models and flattened models. |
| `options.flattenModels` | `(string \| RegExp \| { test: string \| RegExp, doc: (model: StrapiModel) => string })[]`   | `[]` | An array of `RegExp`'s that are matched against the `uid` property of each model to determine if it should be flattened (see [collection flattening](#collection-flattening)). Alternatively, and array of objects with `test` and `doc` properties, where `test` is the aforementioned `RegExp` and `doc` is a function taking the model instance and returning a document path where the collection should be stored.<br><br>This is useful for flattening models built-in models or plugin models where you don't have access to the model configuration. Defaults an empty array (no flattening). |
| `options.allowNonNativeQueries` | `boolean` | `true` | Allow the connector to manually perform search and other query types than are not natively supported by Firestore (see [Search and non-native queries](#search-and-non-native-queries)). These can have poor performance and higher usage costs. If disabled, then search will not function. Defaults to `true` because the `strapi-admin` package uses non-native queries. |

### Model options

In addition to the normal model options, you can provide the following to customise Firestore behaviour. This configuration is in the model's JSON file: `./api/{model-name}/models/{model-name}.settings.json`.

| Name                    | Type        | Default     | Description                     |
|-------------------------|-------------|-------------|---------------------------------|
| `options.singleId`      | `string \| undefined` | `undefined` | If defined, overrides the connector's global `singleId` setting (see above) for this model. |
| `options.flatten`       | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `flattenModels` setting (see above) for this model. |
| `options.allowNonNativeQueries` | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `allowNonNativeQueries` setting (see above) for this model. If this model is flattened, this setting is ignored and non-native queries including search are supported. |

### Collection flattening

You can choose to "flatten" a collection of Firestore documents down to fields within a single Firestore document. Considering that Firestore charges for document read and write operations, you may choose to flatten a collection to reduce usage costs and/or improve performance, however it may increase bandwidth costs as the collection will always be retrieved in it's entirety. 

Flattening may be especially beneficial for collections that are often counted or queried in their entirety anyway. It will cost a single read to retrieve the entire flattened collection, but with increased bandwidth usage. If a collection is normally only queried one document at a time, then that would only have resulted in a single in the first place.

Flattening also enables search and other query types that are not natively supported in Firestore.

Before choosing to flatten a collection, consider the following:

- The collection should be bounded (i.e. you can guarantee that there will only be a finite number of entries). For example, a collection of users would be unbounded, but Strapi configurations and permissions/roles would be bounded.
- The number of entries and size of the entries must fit within a single Firestore document. The size limit for a Firestore document is 1MiB ([see limits](https://firebase.google.com/docs/firestore/quotas#limits)).
- The benefits of flattening will be diminished if the collection is most commonly queried one document at a time (flattening would increase bandwith usage with same amount of read operations). 

### Search and non-native queries

Firestore does not natively support search. Nor does it support several Strapi filter types such as:

- `'ne'` (inequality/not-equal)
- `'nin'` (not included in array of values)
- `'contains'` (case-insensitive string contains)
- `'containss'` (case-sensitive string contains)
- `'ncontains'` (case-insensitive string doesn't contain)
- `'ncontainss'` (case-sensitive string doesn't contain)

This connector manually implements search and these other filters by reading the Firestore collection in blocks without any filters, and then manually filtering the results. This can cause poor performance, and also increased usage costs, because more documents are read from Firestore.

You can disable search and manual query implementations using the `allowNonNativeQueries` option, which is enabled by default. It is recommended that you do on specific models where you may be concerned about usage cost exposure. The current implementation of `strapi-admin` (as of `3.1.0`) actually uses non-native queries on it's models so it must be enabled on those modules for Strapi to function.

Flattened models support all of these filters including search, because the collection is fetched as a whole anyway.

### Minimal example

This is the minimum possible configuration, which will only work for GCP platforms that support Application Default Credentials.

```javascript
// ./config/database.js
module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
    }
  },
});
```

### Full example

This configuration will work for production deployments, and also local development using an emulator (when `process.env.NODE_ENV == 'development'`). 

For production deployments on non-GCP platforms (not supporting Application Default Credentials), make sure to download a service account key file, and set an environment variable `GOOGLE_APPLICATION_CREDENTIALS` pointing to the file. See [Obtaining and providing service account credentials manually](https://cloud.google.com/docs/authentication/production#obtaining_and_providing_service_account_credentials_manually).

```javascript
// ./config/database.js
module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      settings: {
        projectId: '{YOUR_PROJECT_ID}',
      },
      options: {
        // Connect to a local running Firestore emulator
        // when running in development mode
        useEmulator: env('NODE_ENV') == 'development',
        singleId: 'default',

        // Flatten internal Strapi models (as an example)
        // However, flattening the internal Strapi models is
        // not actaully an effective usage of flattening, 
        // because they are only queried one-at-a-time anyway
        // So this would only result in increased bandwidth usage
        flattenCore: [
          {
            test: /^strapi::/,
            doc: ({ uid }) => uid.replace('::', '/')
          }
        ],

        // Disable search and non-native queries on all models (not compatible with strapi-admin)
        allowNonNativeQueries: false
      }
    }
  },
});
```

### Model configuration examples

You can override some configuration options in each models JSON file `./api/{model-name}/models/{model-name}.settings.json`. 

In this example, the collection will be flattened and the connector's `singleId` option will be used as the document name, with the collection name being `collectionName` or `glabalId` (in this example, `"myCollection/default"`):

```json
{
  "kind": "collectionType",
  "collectioName": "myCollection",
  "options": {
    "flatten": true
  }
}
```

The document name can also be specified explicity (in this example `"myCollection/myDoc"`):

```json
{
  "kind": "collectionType",
  "collectioName": "myCollection",
  "options": {
    "flatten": "myDoc"
  }
}
```

You can also overrive the connector's `allowNonNativeQueries` option:

```json
{
  "kind": "collectionType",
  "collectioName": "myCollection",
  "options": {
    "allowNonNativeQueries": false
  }
}
```


## Considerations

### Indexes

Firestore requires an index for every query, and it automatically creates indexes for basic queries ([read more](https://firebase.google.com/docs/firestore/query-data/indexing)). 

Depending on the sort of query operations you will perform, this means that you may need to manually create indexes or those queries will fail.


### Costs

Unlike other cloud database providers that charge based on the provisioned capacity/performance of the database, Firestore charges based on read/write operations, storage, and network egress.

While Firestore has a free tier, be very careful to consider the potential usage costs of your project in production.

Be aware that the Strapi Admin console can very quickly consume several thousand read and write operations in just a few minutes of usage.

For more info, read their [pricing calculator](https://firebase.google.com/pricing#blaze-calculator).

### Security

The Firestore database can be accessed directly via the many client SDKs available to take advantage of features like realtime updates.

This means that there will be two security policies in play: Firestore security rules ([read more](https://firebase.google.com/docs/firestore/security/overview)), and Strapi's own access control via the Strapi API ([read more](https://strapi.io/documentation/v3.x/plugins/users-permissions.html#concept)).

Be sure to secure your data properly by considering several options
- Disable all access to Firestore using security rules, and use Strapi API only.
- Restrict all Strapi API endpoints and use Firestore security rules only.
- Integrate Strapi users, roles and permissions with Firebase Authentication and configure both Firestore security rules and Strapi access control appropriately.
