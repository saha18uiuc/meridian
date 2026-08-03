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
import { nodeFinding, reviewRound } from '../helpers/review.js';

/**
 * The comment state machine.
 *
 * The interesting rule is the one that is *not* there: replying to an issue does not resolve it.
 * Only the next review round, seeing that the issue is gone, may do that. An operator who could
 * close their own findings would be able to argue a board into a clean bill of health.
 */

const ISSUE = 'det:missing_owner:node:action:1';

let owner: string;
let board: SeededBoard;
let rootId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
  await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
  rootId = await rootCommentId();
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

async function rootCommentId(): Promise<string> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ comment_id: string }>(
      'select comment_id from public.comments where parent_comment_id is null limit 1',
    ),
  );
  const id = rows[0]?.comment_id;
  if (id === undefined) throw new Error('no root comment was created');
  return id;
}

async function statusOf(commentId: string): Promise<string | null> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ status: string | null; resolved_at: string | null }>(
      'select status, resolved_at from public.comments where comment_id = $1',
      [commentId],
    ),
  );
  return rows[0]?.status ?? null;
}

async function replies(): Promise<Array<{ body: string; kind: string; author_type: string }>> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ body: string; kind: string; author_type: string }>(
      `select body, metadata_json->>'kind' as kind, author_type
         from public.comments where parent_comment_id is not null order by created_at, comment_id`,
    ),
  );
  return rows;
}

describe('reply_to_comment', () => {
  it('moves an open root to answered and never to resolved', async () => {
    const result = await rpcAsUser<{ rootStatus: string }>(owner, 'reply_to_comment', [
      rootId,
      'The consignee is always the notify party here.',
    ]);
    expect(result.rootStatus).toBe('answered');
    expect(await statusOf(rootId)).toBe('answered');
  });

  it('attaches the reply to the same thread with the operator as author', async () => {
    await rpcAsUser(owner, 'reply_to_comment', [rootId, 'Answered.']);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ thread_id: string; author_user_id: string | null }>(
        'select thread_id, author_user_id from public.comments where parent_comment_id is not null',
      ),
    );
    expect(rows[0]).toMatchObject({ thread_id: rootId, author_user_id: owner });
  });

  it('refuses an empty body', async () => {
    await expectPgError(rpcAsUser(owner, 'reply_to_comment', [rootId, '   ']), 'EMPTY_BODY');
  });

  it('refuses a reply to a reply, keeping threads two levels deep', async () => {
    const reply = await rpcAsUser<{ commentId: string }>(owner, 'reply_to_comment', [rootId, 'A']);
    await expectPgError(
      rpcAsUser(owner, 'reply_to_comment', [reply.commentId, 'B']),
      'CANNOT_REPLY_TO_REPLY',
    );
  });

  it('refuses a stranger, who cannot even learn the comment exists', async () => {
    const [stranger] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsUser(stranger, 'reply_to_comment', [rootId, 'Hello']),
      'COMMENT_NOT_FOUND_OR_FORBIDDEN',
    );
  });
});

describe('reject_comment', () => {
  it('records the rationale as a system reply in the same transaction', async () => {
    await rpcAsUser(owner, 'reject_comment', [rootId, 'Handled by the carrier contract.']);
    expect(await statusOf(rootId)).toBe('rejected');
    expect(await replies()).toEqual([
      {
        body: 'Rejected: Handled by the carrier contract.',
        kind: 'rejection',
        author_type: 'system',
      },
    ]);
  });

  it('refuses an empty reason', async () => {
    await expectPgError(rpcAsUser(owner, 'reject_comment', [rootId, ' ']), 'EMPTY_REASON');
  });

  it('cannot be faked by flipping the status without a rationale', async () => {
    // The rationale requirement is a deferred constraint trigger, so it fires at COMMIT — which is
    // exactly what lets `reject_comment` insert the reply and set the status in either order.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(`update public.comments set status = 'rejected' where comment_id = $1`, [
          rootId,
        ]),
      ),
      'REJECTION_RATIONALE_REQUIRED',
    );
  });
});

describe('record_explicit_assumption', () => {
  it('answers the root and stores the assumption text for the compiler to carry', async () => {
    const result = await rpcAsUser<{ commentId: string; supersededCommentId: string | null }>(
      owner,
      'record_explicit_assumption',
      [rootId, 'Assume the notify party is the consignee unless stated otherwise.'],
    );
    expect(result.supersededCommentId).toBeNull();
    expect(await statusOf(rootId)).toBe('answered');
    expect((await replies())[0]).toMatchObject({ kind: 'assumption', author_type: 'system' });
  });

  it('supersedes the previous assumption on the same thread instead of accumulating them', async () => {
    const first = await rpcAsUser<{ commentId: string }>(owner, 'record_explicit_assumption', [
      rootId,
      'First reading.',
    ]);
    const second = await rpcAsUser<{ supersededCommentId: string | null }>(
      owner,
      'record_explicit_assumption',
      [rootId, 'Corrected reading.'],
    );
    expect(second.supersededCommentId).toBe(first.commentId);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ superseded: string | null }>(
        `select metadata_json->>'supersededAt' as superseded from public.comments where comment_id = $1`,
        [first.commentId],
      ),
    );
    expect(rows[0]?.superseded).not.toBeNull();
  });

  it('refuses empty text', async () => {
    await expectPgError(
      rpcAsUser(owner, 'record_explicit_assumption', [rootId, '']),
      'EMPTY_ASSUMPTION',
    );
  });
});

describe('the status transitions themselves', () => {
  it('refuse answered -> resolved outside review reconciliation', async () => {
    await rpcAsUser(owner, 'reply_to_comment', [rootId, 'Answered.']);
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.comments set status = 'resolved', resolved_at = now() where comment_id = $1`,
          [rootId],
        ),
      ),
      'RESOLUTION_REQUIRES_REVIEW_RECONCILIATION',
    );
  });

  it('refuse a transition that is not in the allowed set', async () => {
    await reviewRound(owner, board.boardId, []);
    expect(await statusOf(rootId)).toBe('resolved');
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.comments set status = 'answered', resolved_at = null where comment_id = $1`,
          [rootId],
        ),
      ),
      'ILLEGAL_TRANSITION',
    );
  });

  it('refuse changing the identity of an existing comment', async () => {
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.comments set issue_key = 'det:other:node:action:9' where comment_id = $1`,
          [rootId],
        ),
      ),
      'COMMENT_IDENTITY_IMMUTABLE',
    );
  });
});
