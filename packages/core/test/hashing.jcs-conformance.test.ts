import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/hashing.js';
import { CANONICAL_FIXTURES } from './helpers/factories.js';

/**
 * `canonicalize@3.0.0` is a dev-only dependency used exactly here. We keep our own runtime
 * implementation so we control the rejection semantics (it turns `NaN` into `null` and
 * `undefined` into the literal text `undefined`, both of which would silently corrupt a hash),
 * but we hold ourselves to byte equality with it across the whole corpus.
 */
describe('RFC 8785 conformance against canonicalize@3.0.0', () => {
  it('covers a non-trivial corpus', () => {
    expect(CANONICAL_FIXTURES.length).toBeGreaterThanOrEqual(25);
  });

  for (const fixture of CANONICAL_FIXTURES) {
    it(`is byte-equal for: ${fixture.name}`, () => {
      expect(canonicalJson(fixture.value)).toBe(canonicalize(fixture.value));
    });
  }
});
