import * as _ from 'lodash';
import type { DocumentReference, DocumentSnapshot, FieldPath, Query, QuerySnapshot } from '@google-cloud/firestore';


export interface ReadRepositoryHandler {
  getAll(refs: DocumentReference<any>[], fieldMasks?: (string | FieldPath)[]): Promise<DocumentSnapshot<any>[]>
  getQuery(query: Query<any>): Promise<QuerySnapshot<any>>
}

/**
 * Utility class for transactions that acts as a caching proxy for read operations.
 */
export class ReadRepository {

  private readonly cache = new Map<string, Promise<DocumentSnapshot<any>>>();

  constructor( 
    private readonly handler: ReadRepositoryHandler,
    private readonly delegate?: ReadRepository,
  ) { }

  get size(): number {
    return this.cache.size;
  }

  getAll(refs: DocumentReference[], fieldMasks?: (string | FieldPath)[]): Promise<DocumentSnapshot<any>[]> {

    // No caching if there are any masks defined
    if (fieldMasks && fieldMasks.length) {
      return this.handler.getAll(refs, fieldMasks);
    }
    

    // Unique documents that haven't already been fetched
    const toGet = _.uniqBy(refs.filter(({ path }) => !this.cache.has(path)), ({ path }) => path);

    // Defer any that exist in the delegate repository
    const toRead = this.delegate
      ? toGet.filter(({ path }) => !this.delegate!.cache.has(path))
      : toGet;

    // Memoise a promise for each document
    const toReadAsync = toRead.length 
      ? this.handler.getAll(toGet) 
      : Promise.resolve([]);
    
    toRead.forEach(({ path }, i) => {
      const p = toReadAsync.then(snaps => snaps[i]);
      this.cache.set(path, p);
    });

    // Arrange all the memoised promises as results
    const results = refs.map(({ path }) => {
      return this.cache.get(path) || this.delegate!.cache.get(path)!;
    });
    return Promise.all(results);
  }

  async getQuery(query: Query<any>): Promise<QuerySnapshot<any>> {
    const result = await this.handler.getQuery(query);
    for (const d of result.docs) {
      const { path } = d.ref;
      if (!this.cache.has(path)) {
        this.cache.set(path, Promise.resolve(d));
      }
    }
    return result;
  }
}
