import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';
import { finalizeReview, startReview, type Finding } from '../helpers/review.js';

/**
 * Anchors are validated against the reviewed snapshot, not the live board (A20).
 *
 * A review reasons about the graph as it was when the round opened. If an anchor were checked
 * against the live board, a comment could attach to a node the reviewer never saw — and, worse, a
 * finding about a node the operator deleted mid-review would be silently dropped instead of
 * landing on the snapshot it belongs to.
 */

let owner: string;
let board: SeededBoard;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

function finding(overrides: Partial<Finding> & Pick<Finding, 'issueKey' | 'anchorType'>): Finding {
  return {
    severity: 'blocking',
    body: 'Something is wrong here.',
    origin: 'deterministic',
    ...overrides,
  };
}

describe('a node anchor', () => {
  it('is accepted when the node is in the reviewed snapshot', async () => {
    const session = await startReview(owner, board.boardId);
    await finalizeReview(owner, session.reviewSessionId, [
      finding({
        issueKey: 'det:a:node:action:1',
        anchorType: 'node',
        anchorId: board.actionNodeId,
      }),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ anchor_id: string }>(
        'select anchor_id from public.comments where parent_comment_id is null',
      ),
    );
    expect(rows[0]?.anchor_id).toBe(board.actionNodeId);
  });

  it('is refused when the node exists nowhere', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, [
        finding({ issueKey: 'det:a:node:ghost:1', anchorType: 'node', anchorId: randomUUID() }),
      ]),
      'ANCHOR_NOT_IN_REVIEWED_SNAPSHOT',
    );
  });

  it('is refused when the node was added to the live board after the round opened', async () => {
    const session = await startReview(owner, board.boardId);

    const lateNodeId = randomUUID();
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([
        {
          nodeId: lateNodeId,
          primitiveType: 'rule',
          title: 'Added mid-review',
          data: { ruleKind: 'decision', condition: 'freeTimeDays > 5', branches: [] },
          position: { x: 300, y: 0 },
        },
      ]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);

    // The node is on the board right now, and the check still refuses it — which is the point.
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, [
        finding({ issueKey: 'det:a:node:late:1', anchorType: 'node', anchorId: lateNodeId }),
      ]),
      'ANCHOR_NOT_IN_REVIEWED_SNAPSHOT',
    );
  });

  it('is still accepted when the node was deleted from the live board mid-review', async () => {
    const session = await startReview(owner, board.boardId);
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [board.outcomeNodeId],
      JSON.stringify([]),
      [],
      null,
    ]);

    await finalizeReview(owner, session.reviewSessionId, [
      finding({
        issueKey: 'det:a:node:outcome:1',
        anchorType: 'node',
        anchorId: board.outcomeNodeId,
      }),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        'select count(*)::text as count from public.comments where anchor_id = $1',
        [board.outcomeNodeId],
      ),
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('an edge anchor', () => {
  it('is accepted when the edge is in the reviewed snapshot', async () => {
    const session = await startReview(owner, board.boardId);
    await finalizeReview(owner, session.reviewSessionId, [
      finding({ issueKey: 'det:a:edge:one:1', anchorType: 'edge', anchorId: board.edgeIds[0] }),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ anchor_type: string }>(
        'select anchor_type from public.comments where parent_comment_id is null',
      ),
    );
    expect(rows[0]?.anchor_type).toBe('edge');
  });

  it('is refused when the edge is not', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, [
        finding({ issueKey: 'det:a:edge:ghost:1', anchorType: 'edge', anchorId: randomUUID() }),
      ]),
      'ANCHOR_NOT_IN_REVIEWED_SNAPSHOT',
    );
  });
});

describe('a canvas anchor', () => {
  it('needs no node or edge to point at', async () => {
    const session = await startReview(owner, board.boardId);
    await finalizeReview(owner, session.reviewSessionId, [
      finding({
        issueKey: 'det:no_terminal:canvas:canvas:-',
        anchorType: 'canvas',
        anchorId: null,
      }),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ anchor_type: string; anchor_id: string | null }>(
        'select anchor_type, anchor_id from public.comments where parent_comment_id is null',
      ),
    );
    expect(rows[0]).toMatchObject({ anchor_type: 'canvas', anchor_id: null });
  });

  it('is refused if it also carries an id', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, [
        finding({
          issueKey: 'det:a:canvas:canvas:-',
          anchorType: 'canvas',
          anchorId: board.actionNodeId,
        }),
      ]),
      'ck_comments_anchor_pairing',
    );
  });
});

describe('the reviewed snapshot', () => {
  it('cannot be edited afterwards to make a bad anchor look good', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.review_sessions
              set source_canvas_json = source_canvas_json || '{"nodes": []}'::jsonb
            where review_session_id = $1`,
          [session.reviewSessionId],
        ),
      ),
      'REVIEW_SESSION_IMMUTABLE_FIELD',
    );
  });
});
