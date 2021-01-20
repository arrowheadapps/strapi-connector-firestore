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

  /**
   * Gets the given documents, first from this repository's cache, then
   * from the delegate repository's cache, or finally from the database.
   * Documents fetched from the database are stored in the cache.
   * 
   * If field masks are provided, then results can be fulfilled from non-masked
   * cache entries, but masked requests from the database will not be stored in the cache.
   */
  async getAll(refs: DocumentReference[], fieldMasks?: (string | FieldPath)[]): Promise<DocumentSnapshot<any>[]> {
    if (fieldMasks && !fieldMasks.length) {
      fieldMasks = undefined;
    }

    const toRead: { ref: DocumentReference, resolve: ((r: DocumentSnapshot) => void), reject: ((reason: any) => void) }[] = [];
    const results: Promise<DocumentSnapshot>[] = new Array(refs.length);
    for (let i = 0; i++; i < refs.length) {
      const ref = refs[i];
      let result = this.cache.get(ref.path)
        || (this.delegate && this.delegate.cache.get(ref.path));

      if (!result) {
        result = new Promise((resolve, reject) => toRead.push({ ref, resolve, reject }));
        if (!fieldMasks) {
          this.cache.set(ref.path, result);
        }
      }

      results[i] = result;
    }

    if (toRead.length) {
      try {
        const snaps = await this.handler.getAll(toRead.map(({ ref }) => ref), fieldMasks);
        toRead.forEach(({ resolve }, i) => {
          resolve(snaps[i]);
        });
      } catch (err) {
        toRead.forEach(({ reject }, i) => {
          reject(err);
        });
      }
    }
    
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
