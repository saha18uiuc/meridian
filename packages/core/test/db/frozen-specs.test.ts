import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveSpecHash } from '../../src/compiler.js';
import { sha256Hex } from '../../src/hashing.js';
import type { SpecJson } from '../../src/schemas/spec.js';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';
import { compileBoard } from '../helpers/lineage.js';

/**
 * A frozen spec is an immutable artifact, and the table says so rather than trusting the writer.
 *
 * The identity claim is the important one. `spec_hash` is unique across the whole table, so two
 * different specs cannot present the same hash and a reader who verifies a hash has verified the
 * artifact. Version numbers are unique per board, so "version 2 of this process" names exactly one
 * thing forever.
 */

let owner: string;
let board: SeededBoard;

async function freeze(revisionNo: number, specVersion: number) {
  const compiled = await compileBoard(board.boardId, specVersion);
  return {
    compiled,
    result: await rpcAsService<{ specId: string; specVersion: number; specHash: string }>(
      'freeze_whiteboard_spec',
      [
        owner,
        board.boardId,
        revisionNo,
        JSON.stringify(compiled.snapshot),
        compiled.canvasHash,
        JSON.stringify(compiled.specJson),
        compiled.specHash,
        [],
        false,
        true,
      ],
    ),
  };
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('frozen specs', () => {
  it('records the board revision and canvas hash the spec was compiled from', async () => {
    const { compiled, result } = await freeze(board.revisionNo, 1);
    const { rows } = await asPostgres(async (client) =>
      client.query<{
        source_revision_no: number;
        source_canvas_hash: string;
        spec_hash: string;
        spec_version: number;
      }>('select * from public.frozen_specs where spec_id = $1', [result.specId]),
    );
    expect(rows[0]?.source_revision_no).toBe(board.revisionNo);
    expect(rows[0]?.source_canvas_hash).toBe(compiled.canvasHash);
    expect(rows[0]?.spec_hash).toBe(compiled.specHash);
    expect(rows[0]?.spec_version).toBe(1);
  });

  it('allocates version numbers in sequence as the board moves on', async () => {
    const first = await freeze(board.revisionNo, 1);
    expect(first.result.specVersion).toBe(1);

    // A second freeze needs a changed board; freezing the same revision twice is a conflict, which
    // `freeze-concurrency` covers.
    const renamed = await rpcAsUser<{ revisionNo: number }>(owner, 'rename_whiteboard', [
      board.boardId,
      board.revisionNo,
      'Seeded board, revised',
    ]);
    const second = await freeze(renamed.revisionNo, 2);
    expect(second.result.specVersion).toBe(2);
  });

  it('refuses two specs claiming the same hash', async () => {
    const { compiled } = await freeze(board.revisionNo, 1);
    // Hand-inserted, because no application path can produce this: the point is that the identity
    // claim survives even when the RPC is bypassed.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.frozen_specs
             (spec_id, whiteboard_id, spec_version, source_revision_no, source_canvas_json,
              source_canvas_hash, spec_json, spec_hash, created_by)
           values ($1, $2, 99, 1, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            board.boardId,
            JSON.stringify(compiled.snapshot),
            compiled.canvasHash,
            JSON.stringify(compiled.specJson),
            compiled.specHash,
            owner,
          ],
        ),
      ),
      'uq_frozen_specs_spec_hash',
    );
  });

  it('refuses a second spec with the same version on one board', async () => {
    const { compiled } = await freeze(board.revisionNo, 1);
    const other = { ...(compiled.specJson as Record<string, unknown>), marker: randomUUID() };
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.frozen_specs
             (spec_id, whiteboard_id, spec_version, source_revision_no, source_canvas_json,
              source_canvas_hash, spec_json, spec_hash, created_by)
           values ($1, $2, 1, 1, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            board.boardId,
            JSON.stringify(compiled.snapshot),
            compiled.canvasHash,
            JSON.stringify(other),
            sha256Hex(other),
            owner,
          ],
        ),
      ),
      'uq_frozen_specs_board_version',
    );
  });

  it('refuses a spec whose schema version it does not understand', async () => {
    const compiled = await compileBoard(board.boardId, 1);
    const wrong = { ...(compiled.specJson as Record<string, unknown>), schemaVersion: '2.0' };
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.frozen_specs
             (spec_id, whiteboard_id, spec_version, source_revision_no, source_canvas_json,
              source_canvas_hash, spec_json, spec_hash, created_by)
           values ($1, $2, 1, 1, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            board.boardId,
            JSON.stringify(compiled.snapshot),
            compiled.canvasHash,
            JSON.stringify(wrong),
            sha256Hex(wrong),
            owner,
          ],
        ),
      ),
      'ck_frozen_specs_schema_version',
    );
  });

  it('refuses a hash that is not a sha-256 digest', async () => {
    const compiled = await compileBoard(board.boardId, 1);
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.frozen_specs
             (spec_id, whiteboard_id, spec_version, source_revision_no, source_canvas_json,
              source_canvas_hash, spec_json, spec_hash, created_by)
           values ($1, $2, 1, 1, $3, $4, $5, 'not-a-hash', $6)`,
          [
            randomUUID(),
            board.boardId,
            JSON.stringify(compiled.snapshot),
            compiled.canvasHash,
            JSON.stringify(compiled.specJson),
            owner,
          ],
        ),
      ),
      'ck_frozen_specs_spec_hash_format',
    );
  });

  it('re-canonicalizes to the recorded hash after storage', async () => {
    // `jsonb` does not preserve bytes, so the only way the recorded hash stays meaningful is if
    // canonicalizing the value read back reproduces it. The hash covers the semantic view, which is
    // what lets two freezes of an unchanged board collide instead of quietly diverging.
    const { result } = await freeze(board.revisionNo, 1);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ spec_json: unknown; spec_hash: string }>(
        'select spec_json, spec_hash from public.frozen_specs where spec_id = $1',
        [result.specId],
      ),
    );
    expect(deriveSpecHash(rows[0]?.spec_json as SpecJson)).toBe(rows[0]?.spec_hash);
  });
});
