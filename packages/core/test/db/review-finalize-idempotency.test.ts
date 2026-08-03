import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';
import { finalizeReview, nodeFinding, startReview } from '../helpers/review.js';

/**
 * Finalization is the only place where a review round becomes durable, and the route that calls it
 * has no transaction of its own to retry inside. So it has to survive being called twice with the
 * same arguments — a double-click, a proxy retry, a resumed request — without doubling the comments
 * it wrote the first time.
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

async function commentCount(): Promise<number> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ count: string }>('select count(*)::text as count from public.comments'),
  );
  return Number(rows[0]?.count ?? '0');
}

describe('finalize_review_session', () => {
  it('reports what it wrote on the first call', async () => {
    const session = await startReview(owner, board.boardId);
    const result = await finalizeReview(owner, session.reviewSessionId, [
      nodeFinding(board, 'det:missing_owner:node:action:1'),
      nodeFinding(board, 'det:no_timeout:node:action:2', 'non_blocking'),
    ]);
    expect(result).toMatchObject({
      wasAlreadyCompleted: false,
      inserted: 2,
      recurred: 0,
      resolved: 0,
    });
    expect(await commentCount()).toBe(2);
  });

  it('inserts nothing extra when called a second time', async () => {
    const session = await startReview(owner, board.boardId);
    const findings = [nodeFinding(board, 'det:missing_owner:node:action:1')];
    await finalizeReview(owner, session.reviewSessionId, findings);

    const replay = await finalizeReview(owner, session.reviewSessionId, findings);
    expect(replay).toMatchObject({ wasAlreadyCompleted: true });
    expect(await commentCount()).toBe(1);
  });

  it('replays the counts it recorded rather than recomputing them', async () => {
    const session = await startReview(owner, board.boardId);
    await finalizeReview(owner, session.reviewSessionId, [
      nodeFinding(board, 'det:a:node:action:1'),
      nodeFinding(board, 'det:b:node:action:2'),
    ]);
    // A replay carrying *different* findings must not be treated as a new round: the session is
    // already completed, and its recorded result is the answer.
    const replay = await finalizeReview(owner, session.reviewSessionId, []);
    expect(replay).toMatchObject({ wasAlreadyCompleted: true, inserted: 2, resolved: 0 });
    expect(await commentCount()).toBe(2);
  });

  it('refuses to finalize a session that already failed', async () => {
    const session = await startReview(owner, board.boardId);
    await asPostgres(async (client) =>
      client.query(
        `update public.review_sessions
            set status = 'failed', completed_at = now(), error_json = '{"code":"TIMEOUT"}'::jsonb
          where review_session_id = $1`,
        [session.reviewSessionId],
      ),
    );
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, []),
      'REVIEW_SESSION_NOT_RUNNING',
    );
  });

  it('advances review currency exactly once', async () => {
    const session = await startReview(owner, board.boardId);
    await finalizeReview(owner, session.reviewSessionId, []);
    await finalizeReview(owner, session.reviewSessionId, []);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ last_reviewed_revision_no: number | null }>(
        'select last_reviewed_revision_no from public.whiteboards where whiteboard_id = $1',
        [board.boardId],
      ),
    );
    expect(rows[0]?.last_reviewed_revision_no).toBe(board.revisionNo);
  });

  it('leaves review currency alone when the round fails', async () => {
    const session = await startReview(owner, board.boardId);
    await asPostgres(async (client) =>
      client.query('select public.fail_review_session($1,$2,$3)', [
        owner,
        session.reviewSessionId,
        JSON.stringify({ code: 'MODEL_TIMEOUT' }),
      ]),
    );
    const { rows } = await asPostgres(async (client) =>
      client.query<{ last_reviewed_revision_no: number | null }>(
        'select last_reviewed_revision_no from public.whiteboards where whiteboard_id = $1',
        [board.boardId],
      ),
    );
    expect(rows[0]?.last_reviewed_revision_no).toBeNull();
  });

  it('is idempotent for failure too', async () => {
    const session = await startReview(owner, board.boardId);
    const first = await asPostgres(async (client) =>
      client.query<{ result: { wasAlreadyFailed: boolean } }>(
        'select public.fail_review_session($1,$2,$3) as result',
        [owner, session.reviewSessionId, JSON.stringify({ code: 'MODEL_TIMEOUT' })],
      ),
    );
    const second = await asPostgres(async (client) =>
      client.query<{ result: { wasAlreadyFailed: boolean } }>(
        'select public.fail_review_session($1,$2,$3) as result',
        [owner, session.reviewSessionId, JSON.stringify({ code: 'SOMETHING_ELSE' })],
      ),
    );
    expect(first.rows[0]?.result.wasAlreadyFailed).toBe(false);
    expect(second.rows[0]?.result.wasAlreadyFailed).toBe(true);
  });

  it('rejects findings that are not an array', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      asPostgres(async (client) => {
        await client.query('set local role service_role');
        await client.query('select public.finalize_review_session($1,$2,$3,$4)', [
          owner,
          session.reviewSessionId,
          JSON.stringify({ issueKey: 'det:x:node:action:1' }),
          JSON.stringify({}),
        ]);
      }),
      'INVALID_FINDING_SHAPE',
    );
  });

  it('rejects an issue key that does not match the documented grammar', async () => {
    const session = await startReview(owner, board.boardId);
    await expectPgError(
      finalizeReview(owner, session.reviewSessionId, [
        { ...nodeFinding(board, 'whatever'), issueKey: 'whatever' },
      ]),
      'INVALID_FINDING_SHAPE: issueKey whatever',
    );
  });
});
