import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/hashing.js';
import { closePool, pool } from './helpers/db.js';

/**
 * What PostgreSQL `jsonb` does to a value, and why the hash survives it.
 *
 * `jsonb` does not store bytes. It discards whitespace and key order, keeps only the last of any
 * duplicated key, and normalizes numeric literals through `numeric`. Every one of those would
 * break a hash computed over stored bytes, which is why nothing in this system ever hashes what
 * the database returns verbatim: both sides are re-canonicalized first.
 *
 * This runs against a real database rather than a model of one. The claim being made is about
 * PostgreSQL's behaviour, and a simulation of that behaviour would only ever confirm itself.
 */

async function roundTrip(literal: string): Promise<unknown> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ value: unknown }>('select $1::jsonb as value', [literal]);
    return rows[0]?.value;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe('jsonb round-trip', () => {
  it('preserves the canonical hash across storage', async () => {
    const value = {
      identity: { specId: '11111111-1111-4111-8111-111111111111', specVersion: 1 },
      capabilities: ['mail.read', 'mail.send'],
      process: { nodes: [{ nodeId: 'a', title: 'Arrival notice' }] },
    };
    const stored = await roundTrip(JSON.stringify(value));
    expect(sha256Hex(stored)).toBe(sha256Hex(value));
    expect(canonicalJson(stored)).toBe(canonicalJson(value));
  });

  it('hashes identically whatever order the keys were written in', async () => {
    const first = await roundTrip('{"b":1,"a":2,"c":{"z":1,"y":2}}');
    const second = await roundTrip('{"c":{"y":2,"z":1},"a":2,"b":1}');
    expect(sha256Hex(first)).toBe(sha256Hex(second));
  });

  it('shows that stored bytes are not preserved, which is why nothing hashes them', async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ text: string }>(`select ($1::jsonb)::text as text`, [
        '{  "b" : 1,\n  "a" : 2 }',
      ]);
      // Whitespace gone, keys reordered. A system that hashed this text would produce a different
      // digest for the same value depending on how it was written.
      expect(rows[0]?.text).toBe('{"a": 2, "b": 1}');
    } finally {
      client.release();
    }
  });

  it('keeps only the last of a duplicated key, and the hash follows', async () => {
    const stored = await roundTrip('{"a":1,"a":2}');
    expect(stored).toEqual({ a: 2 });
    expect(sha256Hex(stored)).toBe(sha256Hex({ a: 2 }));
  });

  it('normalizes numeric literals that name the same number', async () => {
    const pairs: [string, string][] = [
      ['{"n":1}', '{"n":1.0}'],
      ['{"n":1}', '{"n":1e0}'],
      ['{"n":0}', '{"n":-0}'],
    ];
    for (const [left, right] of pairs) {
      const a = await roundTrip(left);
      const b = await roundTrip(right);
      expect(sha256Hex(a), `${left} vs ${right}`).toBe(sha256Hex(b));
    }
  });

  it('round-trips astral-plane characters without altering the digest', async () => {
    const value = { text: 'container 𝟙 ✅ 貨櫃' };
    const stored = await roundTrip(JSON.stringify(value));
    expect(sha256Hex(stored)).toBe(sha256Hex(value));
  });

  it('agrees with the database on what a canonical spec hash is', async () => {
    // `freeze_whiteboard_spec` stores `spec_json` as jsonb and the caller supplies `spec_hash`.
    // The two only stay consistent because re-canonicalizing the stored value reproduces the
    // digest, which is exactly what this asserts end to end.
    const spec = {
      schemaVersion: '1.1',
      identity: { name: 'Inbound Import Receiving', specVersion: 1 },
      assumptions: [],
      knownGaps: [],
    };
    const hash = sha256Hex(spec);
    const stored = await roundTrip(canonicalJson(spec));
    expect(sha256Hex(stored)).toBe(hash);
  });
});
