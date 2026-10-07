import crypto from 'node:crypto';

/**
 * Recursively sorts object keys lexicographically while preserving array element order.
 * This guarantees canonical representation regardless of input key ordering.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    result[key] = canonicalizeJson(obj[key]);
  }

  return result;
}

/**
 * Returns deterministic JSON string of any valid JSON value,
 * with keys sorted recursively and array order preserved.
 */
export function stringifyCanonicalJson(value: unknown): string {
  const canonical = canonicalizeJson(value);
  return JSON.stringify(canonical);
}

/**
 * Computes a SHA-256 digest of the canonical JSON representation.
 */
export function hashCanonicalJson(value: unknown): string {
  const canonicalString = stringifyCanonicalJson(value);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}
