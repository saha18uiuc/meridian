import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  NonCanonicalizableValueError,
  serializeNumber,
  sha256Hex,
} from '../src/hashing.js';

describe('numeric canonicalization', () => {
  it('serializes -0 as 0, which is what JCS requires', () => {
    expect(serializeNumber(-0)).toBe('0');
    expect(sha256Hex({ v: -0 })).toBe(sha256Hex({ v: 0 }));
  });

  it('collapses 1, 1.0 and 1e0 to the same token', () => {
    expect(canonicalJson({ v: 1 })).toBe('{"v":1}');
    expect(canonicalJson({ v: 1.0 })).toBe('{"v":1}');
    expect(canonicalJson({ v: 1 })).toBe('{"v":1}');
  });

  it('matches String(n) for exponent formatting rather than hand-rolling one', () => {
    // The last value is written in exponent form on purpose: as a plain literal it would lose
    // precision at parse time, and the test would then be comparing two copies of the same rounding
    // rather than the formatting rule it means to pin.
    for (const n of [1e21, 1e-7, 1.5e300, -2.5e-13, 1.2345678901234568e29]) {
      expect(serializeNumber(n)).toBe(String(n));
    }
  });

  it('throws on NaN and both infinities', () => {
    expect(() => serializeNumber(Number.NaN)).toThrow(NonCanonicalizableValueError);
    expect(() => serializeNumber(Number.POSITIVE_INFINITY)).toThrow(NonCanonicalizableValueError);
    expect(() => serializeNumber(Number.NEGATIVE_INFINITY)).toThrow(NonCanonicalizableValueError);
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(/NaN/);
  });

  it('names the failing path so a rejection is debuggable', () => {
    try {
      canonicalJson({ a: { b: [1, Number.NaN] } });
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(NonCanonicalizableValueError);
      expect((error as NonCanonicalizableValueError).path).toBe('a.b[1]');
    }
  });
});
