import { describe, it, expect } from 'vitest';
import { canonicalizeJson, stringifyCanonicalJson, hashCanonicalJson } from '../../src/domain/canonical.js';

describe('Canonical JSON serialization and hashing', () => {
  it('should produce identical canonical strings for objects with different key order', () => {
    const objA = {
      b: 2,
      a: 1,
      nested: {
        z: 'last',
        y: 'second',
      },
    };

    const objB = {
      a: 1,
      nested: {
        y: 'second',
        z: 'last',
      },
      b: 2,
    };

    expect(stringifyCanonicalJson(objA)).toBe(stringifyCanonicalJson(objB));
    expect(hashCanonicalJson(objA)).toBe(hashCanonicalJson(objB));
  });

  it('should preserve array element order as significant', () => {
    const arrA = { skills: ['a', 'b'] };
    const arrB = { skills: ['b', 'a'] };

    expect(stringifyCanonicalJson(arrA)).not.toBe(stringifyCanonicalJson(arrB));
    expect(hashCanonicalJson(arrA)).not.toBe(hashCanonicalJson(arrB));
  });

  it('should handle primitives and nested arrays correctly', () => {
    const data = {
      tenantId: 'tenant-a',
      version: 1,
      tags: ['one', 'two'],
      active: true,
      extra: null,
    };

    const canonical = canonicalizeJson(data) as Record<string, unknown>;
    expect(Object.keys(canonical)).toEqual(['active', 'extra', 'tags', 'tenantId', 'version']);
  });
});
