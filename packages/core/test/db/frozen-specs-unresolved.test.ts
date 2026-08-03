import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { finalizeReview, nodeFinding, startReview } from '../helpers/review.js';

/**
 * Freezing with unresolved blockers (A18, A26).
 *
 * The separation of review from freeze is deliberate: a review is advice, and an operator who
 * understands their own business may freeze over it. What the system refuses to do is let that
 * happen *silently*. The freeze must name the blockers it is overriding, and the resulting spec
 * carries the list forever.
 */

const BLOCKER = 'det:missing_owner:node:action:1';
const ADVICE = 'det:no_timeout:node:action:2';

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

async function reviewWith(findings: Parameters<typeof finalizeReview>[2]): Promise<void> {
  const session = await startReview(owner, board.boardId);
  await finalizeReview(owner, session.reviewSessionId, findings);
}

async function liveRoots(): Promise<Array<{ comment_id: string; severity: string | null }>> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ comment_id: string; severity: string | null }>(
      `select comment_id, severity from public.comments
        where parent_comment_id is null and status in ('open','answered') order by created_at`,
    ),
  );
  return rows;
}

async function freeze(options: {
  ackBlockers?: boolean;
  ackStale?: boolean;
  unresolved?: string[];
}): Promise<{ specId: string; blockerCount: number; unresolvedCommentIds: string[] }> {
  const compiled = await compileBoard(board.boardId, 1);
  return rpcAsService('freeze_whiteboard_spec', [
    owner,
    board.boardId,
    compiled.revisionNo,
    JSON.stringify(compiled.snapshot),
    compiled.canvasHash,
    JSON.stringify(compiled.specJson),
    compiled.specHash,
    options.unresolved ?? [],
    options.ackBlockers ?? false,
    options.ackStale ?? false,
  ]);
}

describe('a blocking issue that is still open', () => {
  it('stops a freeze that has not acknowledged it', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    await expectPgError(freeze({}), 'UNRESOLVED_BLOCKERS: 1 blocking issue(s)');
  });

  it('lets a freeze through once it is acknowledged, and records the count', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    const result = await freeze({ ackBlockers: true });
    expect(result.blockerCount).toBe(1);
  });

  it('is carried into the spec row as an unresolved comment id', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    const [root] = await liveRoots();
    const result = await freeze({ ackBlockers: true, unresolved: [root?.comment_id ?? ''] });
    expect(result.unresolvedCommentIds).toEqual([root?.comment_id]);
  });

  it('still counts after the operator merely replied to it', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    const [root] = await liveRoots();
    await rpcAsUser(owner, 'reply_to_comment', [root?.comment_id ?? '', 'We know, it is fine.']);
    // `answered` is not `resolved`. An explanation is not a fix, and the freeze still has to say
    // out loud that it is going ahead anyway.
    await expectPgError(freeze({}), 'UNRESOLVED_BLOCKERS');
  });
});

describe('issues that do not block', () => {
  it('let a freeze proceed untouched', async () => {
    await reviewWith([nodeFinding(board, ADVICE, 'non_blocking')]);
    const result = await freeze({});
    expect(result.blockerCount).toBe(0);
  });

  it('include a blocker the operator explicitly rejected', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    const [root] = await liveRoots();
    await rpcAsUser(owner, 'reject_comment', [
      root?.comment_id ?? '',
      'The carrier contract already covers this.',
    ]);
    // A rejected issue is a decision on the record, so it no longer stands in the way.
    const result = await freeze({});
    expect(result.blockerCount).toBe(0);
  });

  it('include a blocker a later round resolved', async () => {
    await reviewWith([nodeFinding(board, BLOCKER, 'blocking')]);
    await reviewWith([]);
    const result = await freeze({});
    expect(result.blockerCount).toBe(0);
  });
});

describe('review currency', () => {
  it('warns when the board moved on since the last completed review', async () => {
    await reviewWith([]);
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [],
      JSON.stringify([]),
      [],
      JSON.stringify({ x: 1, y: 1, zoom: 1 }),
    ]);
    await expectPgError(freezeAtCurrentRevision(false), 'STALE_REVIEW');
  });

  it('proceeds once the staleness is acknowledged, and records that it was', async () => {
    await reviewWith([]);
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [],
      JSON.stringify([]),
      [],
      JSON.stringify({ x: 1, y: 1, zoom: 1 }),
    ]);
    const result = await freezeAtCurrentRevision(true);
    expect(result).toMatchObject({ acknowledgedStaleReview: true });
  });

  it('does not warn when the review is current', async () => {
    await reviewWith([]);
    const result = await freeze({});
    expect(result).toMatchObject({ blockerCount: 0 });
  });
});

async function freezeAtCurrentRevision(
  ackStale: boolean,
): Promise<{ acknowledgedStaleReview: boolean }> {
  const compiled = await compileBoard(board.boardId, 1);
  return rpcAsService('freeze_whiteboard_spec', [
    owner,
    board.boardId,
    compiled.revisionNo,
    JSON.stringify(compiled.snapshot),
    compiled.canvasHash,
    JSON.stringify(compiled.specJson),
    compiled.specHash,
    [],
    false,
    ackStale,
  ]);
}
