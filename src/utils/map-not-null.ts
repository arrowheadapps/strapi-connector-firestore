
export function mapNotNull<T, R>(arr: T[], fn: (item: T, i: number) => R | null | undefined): R[] {
  return arr.map(fn).filter(isNotNull);
}

export function filterNotNull<T>(arr: (T | null | undefined)[]): T[] {
  return arr.filter(isNotNull);
}

export function isNotNull<R>(value: R | null | undefined): value is R {
  return value != null;
}
