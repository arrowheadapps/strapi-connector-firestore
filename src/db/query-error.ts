import { Query } from '@google-cloud/firestore';

export class QueryError extends Error {
  constructor(readonly cause: any, readonly query: Query<any>) {
    super(`Firestore query failed: ${cause.message}`);
  }

  getQueryInfo() {
    // HACK: Using private API, can break if Firestore internal changes.
    // @ts-expect-error
    const { parentPath, collectionId, limit, offset, fieldFilters, fieldOrders, startAt, endAt } = this.query._queryOptions;
    return {
      parentPath, collectionId, limit, offset, fieldFilters, fieldOrders, startAt, endAt
    };
  }

  describeQuery() {
    return JSON.stringify(this.getQueryInfo(), undefined, 2);
  }
}
