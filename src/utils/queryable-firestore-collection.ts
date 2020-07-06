import { QueryableCollection, QuerySnapshot } from "./queryable-collection";
import type { WhereFilterOp, Query, Transaction } from "@google-cloud/firestore";


export class QueryableFirestoreCollection implements QueryableCollection {

  private readonly query: Query

  constructor(query: Query) {
    this.query = query;
  }

  get(trans?: Transaction): Promise<QuerySnapshot> {
    return trans ? trans.get(this.query) : this.query.get();
  }

  where(fieldPath: string, opStr: WhereFilterOp, value: any): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.where(fieldPath, opStr, value));
  }

  orderBy(fieldPath: string, directionStr: "desc" | "asc" = 'asc'): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.orderBy(fieldPath, directionStr));
  }

  limit(limit: number): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.limit(limit));
  }

  offset(offset: number): QueryableCollection {
    return new QueryableFirestoreCollection(this.query.offset(offset));
  }

  search(query: string): QueryableCollection {
    throw new Error("Method not implemented.");
  }

}
