import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalJson, isSha256Hex, sha256Hex } from '../src/hashing.js';
import { CANONICAL_FIXTURES } from './helpers/factories.js';

describe('canonical JSON', () => {
  it('sorts object keys and ignores insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Hex({ b: 1, a: 2 })).toBe(sha256Hex({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order, because array order is author-meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(sha256Hex([1, 2])).not.toBe(sha256Hex([2, 1]));
  });

  it('drops undefined object members and rejects undefined array members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
  });

  it('rejects values with no canonical form', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(/Date/);
    expect(() => canonicalJson(new Map())).toThrow(/Map/);
    expect(() => canonicalJson(new Set())).toThrow(/Set/);
    expect(() => canonicalJson(10n)).toThrow(/BigInt/);
    expect(() => canonicalJson(() => 1)).toThrow(/function/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/symbol/);
  });

  it('escapes strings per RFC 8785 and keeps astral-plane characters intact', () => {
    expect(canonicalJson('a\u0000b')).toBe('"a\\u0000b"');
    expect(canonicalJson('tab\there')).toBe('"tab\\there"');
    expect(canonicalJson('\u{1F600}')).toBe('"\u{1F600}"');
  });

  it('rejects lone surrogates rather than emitting invalid UTF-8', () => {
    expect(() => canonicalJson('\uD800')).toThrow(/lone high surrogate/);
    expect(() => canonicalJson('\uDC00')).toThrow(/lone low surrogate/);
    expect(() => canonicalJson({ '\uD800': 1 })).toThrow(/lone high surrogate/);
  });

  it('produces the same bytes as the string form', () => {
    for (const fixture of CANONICAL_FIXTURES) {
      expect(Buffer.from(canonicalBytes(fixture.value)).toString('utf8')).toBe(
        canonicalJson(fixture.value),
      );
    }
  });

  it('produces a lowercase 64-hex digest for every fixture', () => {
    for (const fixture of CANONICAL_FIXTURES) {
      expect(isSha256Hex(sha256Hex(fixture.value))).toBe(true);
    }
  });

  it('changes the digest when any field value changes', () => {
    const base = { a: 1, nested: { b: 'x' } };
    expect(sha256Hex(base)).not.toBe(sha256Hex({ a: 1, nested: { b: 'y' } }));
    expect(sha256Hex(base)).not.toBe(sha256Hex({ a: 2, nested: { b: 'x' } }));
  });
});
