import { DocumentReference, DocumentSnapshot, Query, QuerySnapshot, Transaction, ReadOptions } from '@google-cloud/firestore';

export class TransactionWrapper {
  private readonly transaction: Transaction
  private readonly writes: ((trans: Transaction) => void)[] = [];

  constructor(transaction: Transaction) {
    this.transaction = transaction;
  }

  get<T>(documentRef: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
  get<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
  get(val): any {
    return this.transaction.get(val)
  }

  getAll<T>(...documentRefsOrReadOptions: (DocumentReference<T> | ReadOptions)[]): Promise<DocumentSnapshot<T>[]> {
    return this.transaction.getAll<T>(...documentRefsOrReadOptions);
  }

  addWrite(writeOp: (trans: Transaction) => void) {
    this.writes.push(writeOp);
  }

  addWrites(writeOps: ((trans: Transaction) => void)[]) {
    this.writes.push(...writeOps);
  }

  doWrites() {
    this.writes.forEach(w => w(this.transaction));
  }
}