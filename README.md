## ⚠️⚠️ Warning: pre-release ⚠️⚠️

This is package an early work in progress an is not suitable for production in it's current state. Feel free to use it an feedback any issues here:
https://github.com/arrowheadapps/strapi-connector-firestore/issues

The shape of the generated database output may break compatibility often while in "alpha" state.

Known issues/not implemented:
- Complex AND/OR queries
- Deep filtering queries

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
| `options.useEmulator`   | `boolean \| undefined`    | `false`     | Connect to a local Firestore emulator instead of the production database. You must start a local emulator yourself using `firebase emulators:start --only firestore` before you start Strapi. See https://firebase.google.com/docs/emulator-suite/install_and_configure. |
| `options.logTransactionStats`   | `boolean \| undefined` | `process.env.NODE_ENV === 'development'` | Indicates whether or not to log the number of read and write operations for every transaction that is executed. Defaults to `true` for development environments and `false` otherwise. |
| `options.logQueries`   | `boolean \| undefined` | `false` | Indicates whether or not to log the details of every query that is executed. Defaults to `false`. |
| `options.singleId`      | `string \| undefined`    | `"default"` | The document ID to used for `singleType` models and flattened models. |
| `options.flattenModels` | `boolean \| string \| RegExp \| FlattenFn \| (string \| RegExp \| FlattenFn)[]`<br/><br/>Where `FlattenFn` is `(model: StrapiModel) => string \| boolean \| DocumentReference \| null \| undefined`. | `false` | A boolean to enable or disable flattening on all models, or a regex or (or array of those) that are matched against the `uid` property of each model, or a function (or array of those) used to test each model to determine if it should be flattened (see [collection flattening](#collection-flattening)). If a function is provided it must return a string which acts as the `singleId` or `true` (in which case the `singleId` option is used) or "falsey". If the returned string contains `"/"` characters then it is parsed as a document path (overrides the models `collectionName` option). It can also return a `DocumentReference` which is used as the document to store the flattened collection (create using `model.firestore.doc(...)`).<br><br>This is useful for flattening models built-in models or plugin models where you don't have access to the model configuration JSON. |
| `options.allowNonNativeQueries` | `boolean \| string \| RegExp \| TestFn \| (string \| RegExp \| TestFn)`<br/><br/>Where `TestFn` is `(model: StrapiModel<T>) => boolean`. | `false` | Indicates whether to allow the connector to manually perform search and other query types than are not natively supported by Firestore (see [Search and non-native queries](#search-and-non-native-queries)). These can have poor performance and higher usage costs, and can cause some queries to fail. If disabled, then search will not function. If a `string` or `RegExp` is provided, then this will be tested against each model's `uid` (but this may still be overridden by the model's own setting).  |
| `options.ensureComponentIds` | `boolean \| undefined` | `true` | If `true`, then ID's are automatically generated and assigned for embedded components (including dynamic zone) if they don't already exist. ID's are assigned immediately before being sent to Firestore, so they aren't be assigned yet during lifecycle hooks. |
| `options.maxQuerySize` | `number \| undefined` | `200` | If defined, enforces a maximum limit on the size of all queries. You can use this to limit out-of-control quota usage. Does not apply to flattened collections which use only a single read operation anyway. Set to `0` to remove the limit. <br/><br/>**WARNING:** It is highly recommend to set a maximum limit, and to set it as low as applicable for your application, to limit unexpected quota usage. |
| `options.metadataField` | `string \| ((attrKey: string) => string) \| undefined` | `"$meta"` | The field used to build the field that will store the metadata map which holds the indexes for repeatable and dynamic-zone components. If it is a string, then it will be combined with the component  field as a postfix. If it is a function, then it will be called with the field of the attribute containing component, and the function must return the string to be used as the field. See [Indexing fields in repeatable and dynamic-zone components](#indexing-fields-in-repeatable-and-dynamic-zone-components). |

### Model options

In addition to the normal model options, you can provide the following to customise Firestore behaviour. This configuration is in the model's JSON file: `./api/{model-name}/models/{model-name}.settings.json`.

| Name                    | Type        | Default     | Description                     |
|-------------------------|-------------|-------------|---------------------------------|
| `collectionName`        | `string \| undefined` | `globalId` | Controls the Firestore collection name used for the model. Defaults to the model's `globalId` if not provided. |
| `options.singleId`      | `string \| undefined` | `undefined` | If defined, overrides the connector's global `singleId` setting (see above) for this model. Note: this is overridden by the result of the connector's `flattenModels` option if a function is provided there. |
| `options.flatten`       | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `flattenModels` setting (see above) for this model. |
| `options.allowNonNativeQueries` | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `allowNonNativeQueries` setting (see above) for this model. If this model is flattened, this setting is ignored and non-native queries including search are supported. |
| `options.searchAttribute` | `string \| undefined` | `undefined` | If defined, nominates a single attribute to be queried natively, instead of performing a manual search. This can be used to enable primitive search when fully-featured search is disabled because of the `allowNonNativeQueries` setting, or to improve the performance or cost of search queries when full search is not required. See [Search and non-native queries](#search-and-non-native-queries). |
| `options.ensureComponentIds` | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `ensureComponentIds` setting (see above) for this model. |
| `options.maxQuerySize` | `number \| undefined` | `undefined` | If defined, overrides the connector's global `maxQuerySize` setting (see above) for this model. Set to `0` to disable the limit. |
| `options.logQueries`   | `boolean \| undefined` | `undefined` | If defined, overrides the connector's global `logQueries` setting (see above) for this model. |
| `options.converter` | `{ toFirestore?: (data: Object) => Object, fromFirestore?: (data: Object) => Object }` | `undefined` | An object with functions used to convert objects going in and out of Firestore. The `toFirestore` function will be called to convert an object immediately before writing to Firestore. The `fromFirestore` function will be called to convert an object immediately after it is read from Firestore. You can config this parameter in a Javascript file called `./api/{model-name}/models/{model-name}.config.js`, which must export an object with the `converter` property. |
| `options.metadataField` | `string \| ((attrKey: string) => string) \| undefined` | `undefined` | If defined, overrides the connector's global `metadataField` setting (see above) for this model. |
| `attributes.*.index` | `true \| string \| { [key: string]: true \| IndexerFn }`<br/><br/>Where `IndexerFn` is `(value: any, component: object) => any`. | `undefined` | Only relevant for attributes in component models. When the component is embedded as a repeatable or dynamic-zone component, this indicates that the containing parent document should maintain an index for this attribute (see [Indexing fields in repeatable and dynamic-zone components](#indexing-fields-in-repeatable-and-dynamic-zone-components)).<br/><br/>If `true`, the attribute will be indexed with the attribute name used as the key. If `string`, the attribute will be indexed with this string used as the key. If an object, then the attribute will be indexed with each key in the object. The value in the object can be `true` directing an index aliased with that key, or a function which can map and filter values in the index. The function takes the value to be indexed, and the containing component object, and returns the value to be stored in the index, or `undefined` for the value to be omitted. |


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
        singleId: 'default',

        // Decrease max query size limit (default is 200)
        maxQuerySize: 100,

        // Connect to a local running Firestore emulator
        // when running in development mode
        useEmulator: env('NODE_ENV') == 'development',

        // Flatten all internal Strapi models into a collection called "strapi"
        // WARNING: this is an example only, flattening the internal Strapi models is
        // not actually an effective usage of flattening, because they are only 
        // queried one-at-a-time anyway so this would only result in increased bandwidth usage
        flattenModels: ({ uid, collectionName }) => 
          ['strapi::', 'plugins::users-permissions'].some(str => uid.includes(str)) ? `strapi/${collectionName}` : false,

        // Enable search and non-native queries on all except
        // internal Strapi models (beginning with "strapi::")
        allowNonNativeQueries: /^(?!strapi::).*/,
      }
    }
  },
});
```

### Model configuration examples

You can override some configuration options in each models JSON file `./api/{model-name}/models/{model-name}.settings.json`. 

In this example, the collection will be flattened and the connector's `singleId` option will be used as the document name, with the collection name being `collectionName` or `globalId` (in this example, `"myCollection/default"`):

```json
{
  "kind": "collectionType",
  "collectionName": "myCollection",
  "options": {
    "flatten": true
  }
}
```

The document name can also be specified explicitly (in this example `"myCollection/myDoc"`):

```json
{
  "kind": "collectionType",
  "collectionName": "myCollection",
  "options": {
    "flatten": "myDoc"
  }
}
```

You can also override the connector's `allowNonNativeQueries` option:

```json
{
  "kind": "collectionType",
  "collectionName": "myCollection",
  "options": {
    "allowNonNativeQueries": true
  }
}
```

You can specify data converters for a model in `./api/{model-name}/models/{model-name}.settings.js`, like the example below:

```javascript
module.exports = {
  kind: 'collectionType',
  collectionName: 'myCollection',
  options: {
    converter: {
      toFirestore: (data) => {
        // Convert the data in some way immediately before
        // writing to Firestore
        return {
          ...data,
        };
      },

      fromFirestore: (data) => {
        // Convert the data in some way immediately after
        // reading from Firestore
        return {
          ...data,
        };
      },
    },
  },
  attributes: {
    // ...
  },
};
```

### Collection flattening

You can choose to "flatten" a collection of Firestore documents down to fields within a single Firestore document. Considering that Firestore charges for document read and write operations, you may choose to flatten a collection to reduce usage costs, however it imposes collection size limits and may introduce contention. 

Flattening may be especially beneficial for collections that are often counted or queried in their entirety anyway. It will cost a single read to retrieve the entire flattened collection. If a collection is normally only queried one document at a time, then that would only have resulted in a single in the first place.

Flattening also enables search and other query types that are not natively supported in Firestore.

Before choosing to flatten a collection, consider the following:

- The collection should be bounded (i.e. you can guarantee that there will only be a finite number of entries). For example, a collection of users would be unbounded, but Strapi configurations and permissions/roles would be bounded.
- The number of entries and size of the entries must fit within a single Firestore document. The size limit for a Firestore document is 1MiB ([see limits](https://firebase.google.com/docs/firestore/quotas#limits)).
- The benefits of flattening will be diminished if the collection is most commonly queried one document at a time (in such a case, flattening could increase bandwidth usage with same amount of read operations, although the connector minimises bandwidth using field masks where possible).
- The collection should not me modified often. If entries in the collection are written to at a high frequency, or by different users/clients, then flattening could cause contention, because all of those writes would be targetting the same document.
- Firestore document change listeners will be triggered for all changes to any entry in the collection (because the entire collection is stored within the single document).
- Firestore security rules will apply at the collection-level (because the entire collection is stored within the single document).

### Search and non-native queries

Firestore does not natively support search. Nor does it support several Strapi filter types such as:

- `'contains'` (case-insensitive string contains)
- `'containss'` (case-sensitive string contains)
- `'ncontains'` (case-insensitive string doesn't contain)
- `'ncontainss'` (case-sensitive string doesn't contain)

This connector manually implements search and these other filters by reading the Firestore collection in blocks without any filters, and then "manually" filtering the results. This can cause poor performance, and also increased usage costs, because more documents are read from Firestore.

You can enable manual search and manual implementations of unsupported queries by using the `allowNonNativeQueries` option, but you should consider cost exposure. It is therefore recommended that you only enable this on models that specifically require it.

You can enable a primitive kind of search without enabling `allowNonNativeQueries` by using the `searchAttribute` setting. This nominates a single attribute to query against when a search query is performed. If the attribute is a string, a search query will result in a case-sensitive query for strings starting with the given query term (case-sensitive string prefix). If the attribute of any other type, a search query will result in an equality query on this attribute.

If `searchAttribute` is defined, the primitive search behaviour is used regardless of whether or not fully-featured search is available.

Flattened models support all of these filters including search, because the collection is fetched as a whole and filtered "manually" anyway.


### Indexing fields in repeatable and dynamic-zone components

Repeatable components and dynamic-zone components are embedded as an array in the parent document. Firestore cannot query the document based on any field in the components (cannot query inside array).

To support querying, the connector can be configured to maintain a metadata map (index) for any attribute inside these repeatable components. This configured by adding `"index": true` to any attribute in the component model JSON. This is ignored for non-repeatable components, because they can be queried directly.

The connector automatically does this for all relation attributes. Even if an object is provided for `index`, the connector will always ensure there is a default indexer for all relation attributes, which is required for reverse-lookup of relations to function.

The metadata map is stored in the document in a field named by appending "$meta" to the name of the field storing the components. The map contains a field for every indexed attribute, and each field is an array of all the unique values of that attribute on all the components, or `null` if there are no values. If the attribute itself is an array (e.g. many-way relations), then the array is flattened.

Indexers can be defined for the component ID (primary key) also, and if only the `index` property is defined, then the attribute will be deleted after the indexers have been collected. This way, you can index the IDs without the attribute being visible in the content manager.

Note: when indexing attributes inside components, the data will be duplicated inside the document, increasing document size and bandwidth costs.

For example, consider a model JSON with the shape below:

```JSON
{
  "attributes": {
    "myRepeatableComponents": {
      "component": "my-component",
      "repeatable": true
    }
  }
}
```

Where the "my-component" model JSON is like below:

```JSON
{
  "attributes": {
    "name": {
      "type": "string",
      "index": true
    },
    "name": {
      "type": "string",
      "index": true
    },
    "related": {
      "model": "otherModel"
    }
  }
}
```

Such a model may have a document with the database output below:

```JSON
{
  "myRepeatableComponents": [
    {
      "name": "Component 1",
      "related": "/otherModel/doc1", (DocumentReference)
    },
    {
      "name": "Component 2",
      "related": null,
    }
  ],
  "myRepeatableComponents$meta": {
    "name": [
      "Component 1",
      "Component 2"
    ],
    "related": [
      "/collection/doc1", (DocumentReference)
      null
    ]
  },
}
```

Where the `myRepeatableComponents$meta` field is automatically maintained and overwritten by the connector.

In this example, we can query documents based on a field inside a component using a query like `.where('myRepeatableComponents$meta.name', 'array-contains', 'Component 1')`. We can also query a document that contains *any* value with `.where('myRepeatableComponents$meta.name', '!=', null)`, or a document that contains no values with `.where('myRepeatableComponents$meta.name', '==', null)`.


Advanced indexing can be configured as below (in the component model config):

```JavaScript
module.exports = {
  options: {
    // Rename the metadata map with prefix rather than postfix
    metadataField: field => `index$${field}`,
  },
  attributes: {
    id: {
      // Index the primary key
      // This attribute will be removed from existence after the indexer configuration is collected
      index: true,
    }
    name: {
      type: 'string',
      // Index and rename the metadata key instead of default "name"
      // Non-relation attributes are not indexed by default
      index: 'names',
    }
    active: {
      type: 'boolean',
      // Index with default name "active"
      index: true,
    },
    related: {
      collection: 'other-model',
      // Because it is a relation, the connector will always apply a
      // default indexer in addition to those defined in indexedBy
      // but we can override the key
      index: {
        // Rename default indexer
        // If this is omitted then a default indexer with the
        // attribute name "related" will be ensured because
        // this is a relation attribute
        relations: true,
        // Create an index of all relations that are active
        relationsActive: (value, obj) => obj.active ? value : undefined,
        // Create an index of all relations that are inactive
        relationsInactive: (value, obj) => obj.active ? undefined : value,
      },
    },
  },
};
```

Which would result in a database output like below:

```JSON
{
  "myRepeatableComponents": [
    {
      "name": "Component 1",
      "active": true,
      "related": "/otherModel/doc1" (DocumentReference)
    },
    {
      "name": "Component 2",
      "active": false,
      "related": null
    }
  ],
  "index$myRepeatableComponents": {
    "names": [
      "Component 1",
      "Component 2"
    ],
    "active": [
      true,
      false
    ],
    "relations": [
      "/collection/doc1", (DocumentReference)
      null
    ],
    "relationsActive": [
      "/collection/doc1" (DocumentReference)
    ],
    "relationsInactive": [
      null
    ]
  }
}
```

## Considerations

### Strapi components (including dynamic-zone, repeatable)

The official Strapi connectors behave in a way where components are stored separately in their own collections/tables.

However, this connector behaves differently. It embeds all components directly into the parent document, and there are no collections for components. Here are the motivations behind this behaviour:
- Firestore charges for the number of operations performed, so we typically wish to minimise the number of read operations accrued. Embedding the components means no additional reads are required.
- Firestore doesn't natively support populating relational data, so embedding components reduces the latency that would be incurred by several round trips of read operations.
- Typical usage via the Strapi admin front-end doesn't allow reuse of components, meaning all components are unique per parent document anyway, so there is not reason not to embed.

Be aware of the Firestore document size limit, so a single document can contain only a finite number of embedded components.

The connector automatically maintains an index for every relation inside a repeatable component or a dynamic-zone component. This "index" is a map stored in the parent document alongside the embedded components (See [Indexing fields in repeatable and dynamic-zone components](#indexing-fields-in-repeatable-and-dynamic-zone-components)), and enables reverse-lookup of relations inside components.

### Indexes

Firestore requires an index for every query, and it automatically creates indexes for basic queries ([read more](https://firebase.google.com/docs/firestore/query-data/indexing)). 

Depending on the sort of query operations you will perform, this means that you may need to manually create indexes or those queries will fail.


### Costs

Unlike other cloud database providers that charge based on the provisioned capacity/performance of the database, Firestore charges based on read/write operations, storage, and network egress.

While Firestore has a free tier, be very careful to consider the potential usage costs of your project in production.

Be aware that the Strapi Admin console can very quickly consume several thousand read and write operations in just a few minutes of usage.

Particularly, when viewing a collection in the Strapi Admin console, the console will count the collection size, which will incur a read operation for every single document in the collection. This would be disastrous for quota usage for large collections. This is why it is highly recommended to apply the `maxQuerySize` setting, and to set it as low as possible.

For more info on pricing, see the [pricing calculator](https://firebase.google.com/pricing#blaze-calculator).

### Security

The Firestore database can be accessed directly via the many client SDKs available to take advantage of features like realtime updates.

This means that there will be two security policies in play: Firestore security rules ([read more](https://firebase.google.com/docs/firestore/security/overview)), and Strapi's own access control via the Strapi API ([read more](https://strapi.io/documentation/v3.x/plugins/users-permissions.html#concept)).

Be sure to secure your data properly by considering several options
- Disable all access to Firestore using security rules, and use Strapi API only.
- Restrict all Strapi API endpoints and use Firestore security rules only.
- Integrate Strapi users, roles and permissions with Firebase Authentication and configure both Firestore security rules and Strapi access control appropriately.
