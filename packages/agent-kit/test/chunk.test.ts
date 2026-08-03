import { describe, expect, it } from 'vitest';
import { chunk } from '../src/chunk.js';

describe('chunk', () => {
  it('splits an array into fixed-size groups preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one group when the size exceeds the length', () => {
    expect(chunk(['a', 'b'], 10)).toEqual([['a', 'b']]);
  });

  it('returns no groups for an empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('is deterministic across repeated calls', () => {
    const input = ['c', 'a', 'b', 'd'];
    expect(chunk(input, 3)).toEqual(chunk(input, 3));
  });

  it('does not sort, because ordering is the caller\u2019s decision', () => {
    expect(chunk(['c', 'a', 'b'], 2)).toEqual([['c', 'a'], ['b']]);
  });

  it('rejects a non-positive or fractional size', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });

  it('does not mutate the input', () => {
    const input = [1, 2, 3];
    chunk(input, 2);
    expect(input).toEqual([1, 2, 3]);
  });
});
