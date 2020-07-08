# Tests

This directory contains a skeleton Strapi project configuration using this Firestore connector, and the test setup scripts copied from the Strapi repo.

## Test procedure

1. Clean the Strapi project configuration
2. Copy the end-to-end tests out of the `strapi` package (Jest seemingly refuses to run them while inside `node_modules`)
3. Start the Firestore emulator
4. Start Strapi
5. Run the end-to-end tests from the `strapi` package
