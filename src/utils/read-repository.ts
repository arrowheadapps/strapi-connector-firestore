import * as _ from 'lodash';
import { DocumentReference, DocumentSnapshot, FieldPath, Query, QuerySnapshot } from '@google-cloud/firestore';


export interface ReadRepositoryHandler {
  getAll(refs: DocumentReference<any>[], fieldMasks?: (string | FieldPath)[]): Promise<DocumentSnapshot<any>[]>
  getQuery(query: Query<any>): Promise<QuerySnapshot<any>>
}

export interface RefAndMask {
  ref: DocumentReference
  fieldMasks?: (string | FieldPath)[]
}

interface GroupedReadOps {
  fieldMasks: (string | FieldPath)[] | undefined
  ops: ReadOp[]
}

interface ReadOp {
  ref: DocumentReference
  resolve: ((r: DocumentSnapshot) => void)
  reject: ((reason: any) => void)
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
  async getAll(items: RefAndMask[]): Promise<DocumentSnapshot<any>[]> {

    const toRead: GroupedReadOps[] = [];
    const results: Promise<DocumentSnapshot>[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const { ref, fieldMasks } = items[i];
      let result = this.cache.get(ref.path)
        || (this.delegate && this.delegate.cache.get(ref.path));

      if (!result) {
        // Create a new read operation grouped by field masks
        result = new Promise((resolve, reject) => {
          const op: ReadOp = { ref, resolve, reject };
          for (const entry of toRead) {
            if (isFieldPathsEqual(entry.fieldMasks, fieldMasks)) {
              entry.ops.push(op);
              return;
            }
          }
          toRead.push({
            fieldMasks,
            ops: [op],
          });
        });

        // Only cache the new read operation if there is no field mask
        if (!fieldMasks) {
          this.cache.set(ref.path, result);
        }
      }

      results[i] = result;
    }

    // Fetch and resolve all of the newly required read operations
    await Promise.all(toRead.map(ops => fetchGroupedReadOp(ops, this.handler)));
    
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

async function fetchGroupedReadOp({ fieldMasks, ops }: GroupedReadOps, handler: ReadRepositoryHandler) {
  try {
    const snaps = await handler.getAll(ops.map(({ ref }) => ref), fieldMasks);
    let i = ops.length;
    while (i--) {
      ops[i].resolve(snaps[i]);
    }
  } catch (err) {
    for (const { reject } of ops) {
      reject(err);
    }
  }
}

function isFieldPathsEqual(a: (string | FieldPath)[] | undefined, b: (string | FieldPath)[] | undefined) {
  return _.isEqualWith(a, b, (aVal, bVal) => {
    if (aVal instanceof FieldPath) {
      return aVal.isEqual(bVal);
    }
    return undefined;
  });
}
