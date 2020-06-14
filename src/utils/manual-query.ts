import { Query, Transaction, DocumentData, QueryDocumentSnapshot, DocumentSnapshot } from '@google-cloud/firestore';

export type ManualFilter = ((data: DocumentData) => boolean);

/**
 * Given a Firestore query and additional manual filters, this fills
 * the query and applies the manual filters, performing multiple queries
 * if necessary to fulfil the given limit. 
 */
export async function manualQuery(baseQuery: Query, manualFilters: ManualFilter[], operation: 'and' | 'or', limit: number, transaction?: Transaction) {

  let cursor: DocumentSnapshot | undefined
  let docs: QueryDocumentSnapshot[] = [];
  while (docs.length < limit) {
    if (limit) {
      baseQuery = baseQuery.limit(limit);
    }
    if (cursor) {
      baseQuery = baseQuery.startAfter(cursor);
    }

    const result = await (transaction ? transaction.get(baseQuery) : baseQuery.get());
    if (result.empty) {
      break;
    }

    let resultDocs = result.docs;
    cursor = resultDocs[resultDocs.length - 1];
    if (manualFilters.length) {
      if (operation === 'or') {
        resultDocs = resultDocs.filter((doc) => manualFilters.some(op => op(doc.data())));
      } else {
        resultDocs = resultDocs.filter((doc) => manualFilters.every(op => op(doc.data())));
      }
    }

    if ((docs.length + resultDocs.length) > limit) {
      docs = docs.concat(resultDocs.slice(0, limit - docs.length));
    } else {
      docs = docs.concat(resultDocs);
    }
  }

  return docs;
}
