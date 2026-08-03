import { describe, expect, it } from 'vitest';
import { deriveActionKey, markerToken } from '../src/idempotency.js';

const base = {
  executionId: '11111111-1111-4111-8111-111111111111',
  stepInstanceKey: 'send-response:MSKU1234567',
  actionType: 'mail.send',
};

describe('deriveActionKey', () => {
  it('produces 64 lower-case hex characters', () => {
    const key = deriveActionKey({ ...base, payload: { to: 'a@b.c' } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of payload key order', () => {
    const left = deriveActionKey({ ...base, payload: { a: 1, b: 2 } });
    const right = deriveActionKey({ ...base, payload: { b: 2, a: 1 } });
    expect(left).toBe(right);
  });

  it('changes when any of the four inputs changes', () => {
    const reference = deriveActionKey({ ...base, payload: { to: 'a@b.c' } });
    expect(
      deriveActionKey({
        ...base,
        executionId: '22222222-2222-4222-8222-222222222222',
        payload: { to: 'a@b.c' },
      }),
    ).not.toBe(reference);
    expect(
      deriveActionKey({ ...base, stepInstanceKey: 'other', payload: { to: 'a@b.c' } }),
    ).not.toBe(reference);
    expect(
      deriveActionKey({ ...base, actionType: 'mail.draft', payload: { to: 'a@b.c' } }),
    ).not.toBe(reference);
    expect(deriveActionKey({ ...base, payload: { to: 'z@b.c' } })).not.toBe(reference);
  });

  it('is stable across repeated derivations, carrying no clock or randomness', () => {
    const first = deriveActionKey({ ...base, payload: { n: 1 } });
    const second = deriveActionKey({ ...base, payload: { n: 1 } });
    expect(first).toBe(second);
  });

  it('distinguishes nested reorderings that are semantically identical from real changes', () => {
    const a = deriveActionKey({ ...base, payload: { outer: { x: 1, y: [1, 2] } } });
    const b = deriveActionKey({ ...base, payload: { outer: { y: [1, 2], x: 1 } } });
    const c = deriveActionKey({ ...base, payload: { outer: { y: [2, 1], x: 1 } } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('markerToken', () => {
  it('is the first twelve characters of the key', () => {
    const key = deriveActionKey({ ...base, payload: {} });
    expect(markerToken(key)).toBe(key.slice(0, 12));
    expect(markerToken(key)).toHaveLength(12);
  });
});
