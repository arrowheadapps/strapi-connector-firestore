
export interface PrefixQueryTerms {
  gte: string,
  lt: string
}

/**
 * Firestore-native method to query for prefix.
 * See: https://stackoverflow.com/a/46574143/1513557
 * @param value 
 */
export function buildPrefixQuery(value: string): PrefixQueryTerms {
  return {
    gte: value,
    lt: value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1), // Lexicographically increment the last character
  };
}
