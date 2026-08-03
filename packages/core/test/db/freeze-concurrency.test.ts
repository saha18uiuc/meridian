import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  openSession,
  rpcAsService,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';
import { compileBoard, openReviewSession } from '../helpers/lineage.js';
import { finalizeReview } from '../helpers/review.js';

/**
 * Freezing is the moment a mutable drawing becomes an immutable contract, so it is the one place
 * where a lost update would be unrecoverable: two specs claiming to be version 1 of the same board
 * would make `spec_version` meaningless and break every downstream lineage assertion.
 *
 * The protection is the board row lock plus a re-check that the board is still at the revision the
 * caller compiled. These tests hold two real connections open at once so the lock is exercised
 * rather than assumed.
 */

let owner: string;
let board: SeededBoard;
let openSessionId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
  openSessionId = await openReviewSession(owner, board.boardId);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

type Compiled = Awaited<ReturnType<typeof compileBoard>>;

function freezeArgs(compiled: Compiled, ackStaleReview = true): unknown[] {
  return [
    owner,
    board.boardId,
    compiled.revisionNo,
    JSON.stringify(compiled.snapshot),
    compiled.canvasHash,
    JSON.stringify(compiled.specJson),
    compiled.specHash,
    [],
    false,
    ackStaleReview,
  ];
}

function freeze(compiled: Compiled, ackStaleReview = true) {
  return rpcAsService<{ specId: string; specVersion: number }>(
    'freeze_whiteboard_spec',
    freezeArgs(compiled, ackStaleReview),
  );
}

describe('two freezes racing on one board', () => {
  it('lets exactly one win, and the loser is told the board moved on', async () => {
    const first = await compileBoard(board.boardId, 1);
    const second = await compileBoard(board.boardId, 1);

    const a = await openSession('service_role', null);
    const b = await openSession('service_role', null);
    try {
      const placeholders = freezeArgs(first)
        .map((_, i) => `$${i + 1}`)
        .join(', ');
      const sql = `select public.freeze_whiteboard_spec(${placeholders}) as result`;

      // `a` takes the board lock and holds it; `b` blocks on the same row until `a` commits, which
      // is what makes the second attempt see the already-allocated version instead of duplicating it.
      const winner = await a.client.query<{ result: { specVersion: number } }>(
        sql,
        freezeArgs(first) as never[],
      );
      const loser = b.client.query(sql, freezeArgs(second) as never[]);
      await a.client.query('commit');

      expect(winner.rows[0]?.result.specVersion).toBe(1);
      await expect(loser).rejects.toThrow(/BOARD_CHANGED_DURING_FREEZE/);
      await b.client.query('rollback');
    } finally {
      a.release();
      b.release();
    }

    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>('select count(*)::text as count from public.frozen_specs'),
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('allocates the next version to a freeze that recompiled after the first one landed', async () => {
    // A board may hold only one live review at a time, so the round opened by the fixture has to
    // finish before a second one can be opened for the second freeze.
    await finalizeReview(owner, openSessionId, []);
    await freeze(await compileBoard(board.boardId, 1));

    // A freeze moved the board to `submitted`; editing it returns it to `draft`, and the second
    // review round is what makes `review_ready` reachable again.
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([
        {
          nodeId: board.actionNodeId,
          primitiveType: 'action',
          title: 'Read the mailbox twice',
          data: {
            actor: 'agent',
            operation: 'mail.read',
            instructions: '',
            system: 'gmail',
            inputs: [],
            outputs: [],
          },
          position: { x: 100, y: 0 },
          rowVersion: 1,
        },
      ]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);
    await openReviewSession(owner, board.boardId);

    const second = await freeze(await compileBoard(board.boardId, 2));
    expect(second.specVersion).toBe(2);
  });
});

describe('a board edited between compile and freeze', () => {
  it('aborts rather than freezing a specification of a graph that no longer exists', async () => {
    const compiled = await compileBoard(board.boardId, 1);

    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [],
      JSON.stringify([]),
      [],
      JSON.stringify({ x: 10, y: 10, zoom: 1.5 }),
    ]);

    await expectPgError(freeze(compiled), 'BOARD_CHANGED_DURING_FREEZE');
  });

  it('aborts when the caller lies about the revision to get a stale snapshot through', async () => {
    const compiled = await compileBoard(board.boardId, 1);
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([
        {
          nodeId: randomUUID(),
          primitiveType: 'outcome',
          title: 'Held',
          data: { resultKind: 'blocked', terminal: true },
          position: { x: 400, y: 0 },
        },
      ]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);

    await expectPgError(
      rpcAsService('freeze_whiteboard_spec', [
        owner,
        board.boardId,
        board.revisionNo + 1,
        JSON.stringify(compiled.snapshot),
        compiled.canvasHash,
        JSON.stringify(compiled.specJson),
        compiled.specHash,
        [],
        false,
        true,
      ]),
      // The snapshot's own metadata still says revision N, so the forgery is caught before the
      // structural comparison even runs.
      'SNAPSHOT_METADATA_MISMATCH',
    );
  });
});

describe('the frozen row itself', () => {
  it('adopts the spec id the compiler already hashed', async () => {
    const compiled = await compileBoard(board.boardId, 1);
    const result = await freeze(compiled);
    expect(result.specId).toBe(compiled.specId);
  });

  it('refuses a spec whose identity names a different board', async () => {
    const compiled = await compileBoard(board.boardId, 1);
    const forged = {
      ...(compiled.specJson as { identity: Record<string, unknown> }),
      identity: {
        ...(compiled.specJson as { identity: Record<string, unknown> }).identity,
        whiteboardId: randomUUID(),
      },
    };
    await expectPgError(
      rpcAsService('freeze_whiteboard_spec', [
        owner,
        board.boardId,
        compiled.revisionNo,
        JSON.stringify(compiled.snapshot),
        compiled.canvasHash,
        JSON.stringify(forged),
        compiled.specHash,
        [],
        false,
        true,
      ]),
      'INVALID_SPEC_IDENTITY',
    );
  });

  it('moves the board to submitted', async () => {
    await freeze(await compileBoard(board.boardId, 1));
    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string }>(
        'select status from public.whiteboards where whiteboard_id = $1',
        [board.boardId],
      ),
    );
    expect(rows[0]?.status).toBe('submitted');
  });

  it('cannot be rewritten once written', async () => {
    const result = await freeze(await compileBoard(board.boardId, 1));
    await expectPgError(
      asPostgres(async (client) =>
        client.query(`update public.frozen_specs set spec_version = 99 where spec_id = $1`, [
          result.specId,
        ]),
      ),
      'IMMUTABLE_ROW',
    );
  });
});
