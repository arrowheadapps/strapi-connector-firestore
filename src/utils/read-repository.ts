import * as _ from 'lodash';
import type { DocumentReference, DocumentSnapshot, Query, QuerySnapshot } from '@google-cloud/firestore';


export interface ReadRepositoryHandler {
  getAll(refs: DocumentReference<any>[], fieldMask: string | undefined): Promise<DocumentSnapshot<any>[]>
  getQuery(query: Query<any>): Promise<QuerySnapshot<any>>
}

interface CacheEntry {
  nonMasked?: Promise<DocumentSnapshot>
  masked?: {
    [mask: string]:  Promise<DocumentSnapshot> | undefined
  }
}


/**
 * Utility class for transactions that acts as a caching proxy for read operations.
 */
export class ReadRepository {

  private readonly cache = new Map<string, CacheEntry>();

  constructor( 
    private readonly handler: ReadRepositoryHandler,
    private readonly delegate?: ReadRepository,
  ) { }

  get size(): number {
    return this.cache.size;
  }

  getAll(refs: DocumentReference[], fieldMasks?: string[]): Promise<DocumentSnapshot<any>[]> {

    const readOperations: { ref: DocumentReference, cb: (() => void) }[] = [];

    const entries = refs.map(ref => {
      // Try entries in this cache
      let entry = this.cache.get(ref.path);
      if (entry) {
        if (entry.nonMasked) {
          return entry.nonMasked;
        }
      }

      // Try entries in the delegate cache
      entry = this.delegate && this.delegate.cache.get(ref.path);
      if (entry) {
        if (entry.nonMasked) {
          return entry.nonMasked;
        }
      }

      // Create new entry new data
      entry = { };
      this.cache.set(ref.path, entry);

    });


    // Unique documents that haven't already been fetched
    const toGet = _.uniqBy(
      refs.filter(({ path }) => !this.cache.has(path)),
      ({ path }) => path,
    );

    // Defer any that exist in the delegate repository
    const toRead = this.delegate
      ? toGet.filter(({ path }) => !this.delegate!.cache.has(path + maskPath) && !this.delegate!.cache.has(path))
      : toGet;

    // Memoise a promise for each document
    const toReadAsync = toRead.length 
      ? this.handler.getAll(toGet, fieldMask) 
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
