import { randomUUID } from 'node:crypto';
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
 * The structural rules that separate a root finding from a reply.
 *
 * A root carries the state of an issue — status, severity, issue key — and a reply carries none of
 * them. Written as a pair of `(parent is null) = (field is not null)` checks, that distinction is
 * enforced in both directions at once, so neither a stateless root nor a reply that quietly holds
 * its own status can exist. The alternative, a nullable column policed in application code, is the
 * shape that lets a reply appear in an unresolved-issue count.
 *
 * These are asserted as superuser inserts because no application path can produce them: the point
 * is that the guarantee survives even when the RPCs are bypassed.
 */

let owner: string;
let board: SeededBoard;
let reviewSessionId: string;

async function insertComment(overrides: Record<string, unknown>): Promise<void> {
  const row = {
    comment_id: randomUUID(),
    whiteboard_id: board.boardId,
    review_session_id: reviewSessionId,
    parent_comment_id: null,
    thread_id: null,
    author_type: 'ai',
    author_user_id: null,
    body: 'A finding',
    anchor_type: 'node',
    anchor_id: board.actionNodeId,
    status: 'open',
    severity: 'blocking',
    issue_key: 'det:missing_owner:node:action:1',
    metadata_json: {
      kind: 'review_issue',
      issueKey: 'det:missing_owner:node:action:1',
      origin: 'deterministic',
    },
    ...overrides,
  } as Record<string, unknown>;
  row['thread_id'] ??= row['comment_id'];

  const columns = Object.keys(row);
  await asPostgres(async (client) => {
    await client.query(
      `insert into public.comments (${columns.join(', ')})
       values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => {
        const value = row[column];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      }),
    );
  });
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
  reviewSessionId = (await startReview(owner, board.boardId)).reviewSessionId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('comment structural invariants', () => {
  it('accepts a well-formed root', async () => {
    await expect(insertComment({})).resolves.toBeUndefined();
  });

  it('refuses a root with no status, severity, or issue key', async () => {
    await expectPgError(insertComment({ status: null }), 'ck_comments_root_requires_status');
    await expectPgError(insertComment({ severity: null }), 'ck_comments_root_requires_severity');
    await expectPgError(insertComment({ issue_key: null }), 'ck_comments_root_requires_issue_key');
  });

  it('refuses a reply that carries issue state', async () => {
    const rootId = randomUUID();
    await insertComment({ comment_id: rootId, thread_id: rootId });

    const reply = {
      parent_comment_id: rootId,
      thread_id: rootId,
      author_type: 'user',
      author_user_id: owner,
      status: null,
      severity: null,
      issue_key: null,
      metadata_json: { kind: 'reply' },
    };
    await expect(insertComment(reply)).resolves.toBeUndefined();

    // A reply that holds a status would be counted as its own issue by every unresolved query.
    await expectPgError(
      insertComment({ ...reply, status: 'open' }),
      'ck_comments_root_requires_status',
    );
    await expectPgError(
      insertComment({ ...reply, severity: 'blocking' }),
      'ck_comments_root_requires_severity',
    );
  });

  it('requires a root to be its own thread', async () => {
    await expectPgError(
      insertComment({ thread_id: randomUUID() }),
      'ck_comments_root_thread_identity',
    );
  });

  it('refuses a comment that is its own parent', async () => {
    const id = randomUUID();
    await expectPgError(
      insertComment({
        comment_id: id,
        parent_comment_id: id,
        thread_id: id,
        status: null,
        severity: null,
        issue_key: null,
        metadata_json: { kind: 'reply' },
      }),
      'ck_comments_not_self_parent',
    );
  });

  it('pairs an anchor type with an anchor id', async () => {
    // A node anchor with no id is caught by the snapshot check before the pairing constraint gets
    // to it. Either rejection is the guarantee; asserting the message the database actually
    // produces keeps this test describing the system rather than the order of its checks.
    await expectPgError(insertComment({ anchor_id: null }), 'ANCHOR_NOT_IN_REVIEWED_SNAPSHOT');
    // `canvas` is the one anchor type with nothing to point at, so it must have no id.
    await expect(
      insertComment({ anchor_type: 'canvas', anchor_id: null }),
    ).resolves.toBeUndefined();
    await expectPgError(insertComment({ anchor_type: 'canvas' }), 'ck_comments_anchor_pairing');
  });

  it('refuses an issue key that does not name its origin', async () => {
    for (const issueKey of ['missing_owner', 'ai:missing_owner', 'det:Missing Owner']) {
      await expectPgError(
        insertComment({
          issue_key: issueKey,
          metadata_json: { kind: 'review_issue', issueKey, origin: 'deterministic' },
        }),
        'ck_comments_issue_key_shape',
      );
    }
  });

  it('ties resolved status to a resolution timestamp in both directions', async () => {
    await expectPgError(insertComment({ status: 'resolved' }), 'ck_comments_resolved_at');
    await expectPgError(
      insertComment({ status: 'open', resolved_at: new Date().toISOString() }),
      'ck_comments_resolved_at',
    );
  });

  it('requires a user comment to name its author', async () => {
    const rootId = randomUUID();
    await insertComment({ comment_id: rootId, thread_id: rootId });
    await expectPgError(
      insertComment({
        parent_comment_id: rootId,
        thread_id: rootId,
        author_type: 'user',
        author_user_id: null,
        status: null,
        severity: null,
        issue_key: null,
        metadata_json: { kind: 'reply' },
      }),
      'ck_comments_user_author',
    );
  });

  it('holds for comments the real review path writes', async () => {
    // The invariants above are asserted against hand-built rows; this checks the RPC produces
    // rows that satisfy them, so the constraints are describing the real shape and not a fiction.
    // The session opened in `beforeEach` is the one finalized here — starting a second would hit
    // `uq_review_sessions_active`, which is a different rule with its own test.
    await finalizeReview(owner, reviewSessionId, [
      nodeFinding(board, 'det:unlabeled_branch:node:rule:1'),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        `select count(*) as count from public.comments
         where parent_comment_id is null and (status is null or severity is null or issue_key is null)`,
      ),
    );
    expect(rows[0]?.count).toBe('0');
  });
});
