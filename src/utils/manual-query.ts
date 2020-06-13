import { Query, Transaction, DocumentData, QueryDocumentSnapshot } from '@google-cloud/firestore';

export type ManualFilter = ((data: DocumentData) => boolean);

/**
 * Given a Firestore query and additional manual filters, this fills
 * the query and applies the manual filters, performing multiple queries
 * if necessary to fulfil the given limit. 
 */
export async function manualQuery(baseQuery: Query, manualFilters: ManualFilter[], limit: number, transaction?: Transaction) {


  let docs: QueryDocumentSnapshot[] = [];
  while (docs.length < limit) {
    if (limit) {
      baseQuery = baseQuery.limit(limit);
    }
    if (docs.length) {
      baseQuery = baseQuery.startAfter(docs[docs.length - 1]);
    }

    const result = await (transaction ? transaction.get(baseQuery) : baseQuery.get());
    if (result.empty) {
      break;
    }

    let resultDocs = result.docs;
    if (manualFilters.length) {
      resultDocs = resultDocs.filter((doc) => manualFilters.every(op => op(doc.data())));
    }

    if ((docs.length + resultDocs.length) > limit) {
      docs = docs.concat(resultDocs.slice(0, limit - docs.length));
    } else {
      docs = docs.concat(resultDocs);
    }
  }

  return docs;
}
