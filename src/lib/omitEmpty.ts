/**
 * A result object with the named keys left out where they hold nothing: `undefined`, an empty
 * array, or `0`. Tool results are read by the model as JSON, and a successful build spelled
 * `"errors":[],"warnings":[],"errorsOmittedByCap":0,…` costs tokens on every call to say
 * nothing. Only the keys named are judged — a `0` that means something (a page count, a
 * duration) is never in the list — and each such key's schema says "absent means [] / 0".
 * Returns a fresh object (never the input), as `structuredContent` must be.
 */
export function omitEmpty<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> & Partial<Pick<T, K>> {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) {
    const v = out[k as string];
    if (v === undefined || v === 0 || (Array.isArray(v) && v.length === 0)) delete out[k as string];
  }
  return out as Omit<T, K> & Partial<Pick<T, K>>;
}
