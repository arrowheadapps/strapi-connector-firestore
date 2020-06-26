## ⚠️⚠️ Warning: pre-release ⚠️⚠️

This is package an early work in progress an is not suitable for production in it's current state. Feel free to use it an feedback any issues here:
https://github.com/arrowheadapps/strapi-connector-firestore/issues

Known issues/not implemented
- Higher complexity relations such as many-many, components, and polymorphism are untested

I welcome contributors to help get this package to a production ready state and maintain it.

See the discussion in [issue #1](https://github.com/arrowheadapps/strapi-connector-firestore/issues/1).


# strapi-connector-firestore

[![NPM Version](https://img.shields.io/npm/v/strapi-connector-firestore/latest)](https://www.npmjs.org/package/strapi-connector-firestore)
[![Monthly download on NPM](https://img.shields.io/npm/dm/strapi-connector-firestore)](https://www.npmjs.org/package/strapi-connector-firestore)
[![Snyk Vulnerabilities](https://img.shields.io/snyk/vulnerabilities/npm/strapi-connector-firestore)](https://snyk.io/test/npm/strapi-connector-firestore)
[![GitHub bug issues](https://img.shields.io/github/issues/arrowheadapps/strapi-connector-firestore/bug)](https://github.com/arrowheadapps/strapi-connector-firestore/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/arrowheadapps/strapi-connector-firestore)](https://github.com/arrowheadapps/strapi-connector-firestore)
[![GitHub contributors](https://img.shields.io/github/contributors/arrowheadapps/strapi-connector-firestore)](https://github.com/arrowheadapps/strapi-connector-firestore)
[![Licence](https://img.shields.io/npm/l/strapi-connector-firestore)](https://github.com/arrowheadapps/strapi-connector-firestore/blob/master/LICENSE.md)

Strapi database connector for [Cloud Firestore](https://firebase.google.com/docs/firestore) database on Google Cloud Platform.

Cloud Firestore is a flexible, scalable database for mobile, web, and server development from Firebase and Google Cloud Platform.

It has several advantages such as:
- SDKs for Android, iOS, Web, and many others.
- Realtime updates.
- Integration with the suite of mobile and web development that come with Firebase, such as Authentication, Push Notifications, Cloud Functions, etc.
- Generous [free usage tier](https://firebase.google.com/pricing) so there is no up-front cost to get started.

## Installation

Install the NPM package:

```
$ npm install --save strapi-connector-firestore
```

Configure Strapi (`^3.0.0`) to use the Firestore database connector in `./config/database.js`:

```javascript
module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      // `settings` can be omitted in environments that support
      // application default credentials (e.g. App Engine, Cloud Run, etc)
      // Or provide any Firestore options as specified here:
      // https://googleapis.dev/nodejs/firestore/latest/Firestore.html#Firestore
      settings: {
        projectId: '{YOUR_PROJECT_ID}'
      },
      options: {
        // Connect to a local running Firestore emulator
        // when running in development mode
        useEmulator: process.env.NODE_ENV == 'development'

        // The document ID to use for `singleType` models
        // The document will be located at `"${collectionName}/${singleId}"`
        // Defaults to `"default"`
        singleId: 'default'
      }
    }
  },
});
```

## Considerations

### Indexes

Firestore requires an index for every query, and it automatically creates indexes for basic queries [(read more)](https://firebase.google.com/docs/firestore/query-data/indexing). 

Depending on the sort of query operations you will perform, this means that you may need to manually create indexes or those queries will fail.


### Costs

Unlike other cloud database providers that charge based on the provisioned capacity/performance of the database, Firestore charges based on read/write operations, storage, and network egress.

While Firestore has a free tier, be very careful to consider the potential usage costs of your project in production.

Be aware that the Strapi Admin console can very quickly consume several thousand read and write operations in just a few minutes of usage.

For more info, read their [pricing calculator](https://firebase.google.com/pricing#blaze-calculator).

### Security

The Firestore database can be accessed directly via the many client SDKs available to take advantage of features like realtime updates.

This means that there will be two security policies in play: Firestore security rules [(read more)](https://firebase.google.com/docs/firestore/security/overview), and Strapi's own access control via the Strapi API [(read more)](https://strapi.io/documentation/v3.x/plugins/users-permissions.html#concept).

Be sure to secure your data properly by considering several options
- Disable all access to Firestore using security rules, and use Strapi API only.
- Restrict all Strapi API endpoints and use Firestore security rules only.
- Integrate Strapi users, roles and permissions with Firebase Authentication and configure both Firestore security rules and Strapi access control appropriately.
