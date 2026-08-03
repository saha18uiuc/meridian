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
import { finalizeReview, nodeFinding, startReview } from '../helpers/review.js';

/**
 * `metadata_json`, and the reason it is not a free-form bag.
 *
 * Every comment declares a `kind`, and each kind names the fields that make it meaningful: a
 * rejection without a reason is not a rejection, an assumption without text records nothing, and a
 * policy gap that does not name the eval run it came from cannot be traced back to the failure
 * that produced it. Enforcing this in the database rather than in the six writers is what stops a
 * seventh writer from inventing an eighth shape.
 */

const ISSUE = 'det:missing_owner:node:action:1';

let owner: string;
let board: SeededBoard;
let reviewSessionId: string;
let rootId: string;

async function insertComment(overrides: Record<string, unknown>): Promise<void> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    comment_id: id,
    whiteboard_id: board.boardId,
    review_session_id: reviewSessionId,
    parent_comment_id: rootId,
    thread_id: rootId,
    author_type: 'user',
    author_user_id: owner,
    body: 'A reply',
    anchor_type: 'canvas',
    anchor_id: null,
    status: null,
    severity: null,
    issue_key: null,
    ...overrides,
  };
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
  await finalizeReview(owner, reviewSessionId, [nodeFinding(board, ISSUE)]);
  const { rows } = await asPostgres(async (client) =>
    client.query<{ comment_id: string }>(
      'select comment_id from public.comments where parent_comment_id is null limit 1',
    ),
  );
  rootId = rows[0]?.comment_id as string;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('comment metadata', () => {
  it('requires every comment to declare a kind', async () => {
    await expectPgError(insertComment({ metadata_json: {} }), 'ck_comments_metadata_kind');
    await expectPgError(
      insertComment({ metadata_json: { kind: 'annotation' } }),
      'ck_comments_metadata_kind',
    );
  });

  it('requires a rejection to carry a non-empty reason', async () => {
    await expectPgError(
      insertComment({ metadata_json: { kind: 'rejection' } }),
      'ck_comments_metadata_shape',
    );
    // Whitespace is not a reason. Someone reading the thread later needs to know why the finding
    // was dismissed, and " " tells them nothing.
    await expectPgError(
      insertComment({ metadata_json: { kind: 'rejection', reason: '   ' } }),
      'ck_comments_metadata_shape',
    );
    await expect(
      insertComment({ metadata_json: { kind: 'rejection', reason: 'Out of scope.' } }),
    ).resolves.toBeUndefined();
  });

  it('requires an assumption to carry its text and the answer it came from', async () => {
    await expectPgError(
      insertComment({ metadata_json: { kind: 'assumption', assumptionText: 'CoA is mandatory' } }),
      'ck_comments_metadata_shape',
    );
    await expect(
      insertComment({
        metadata_json: {
          kind: 'assumption',
          assumptionText: 'CoA is mandatory',
          sourceRootCommentId: rootId,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('requires a graph patch to name its version and the revision it landed on', async () => {
    await expectPgError(
      insertComment({ metadata_json: { kind: 'graph_patch', patchVersion: 1 } }),
      'ck_comments_metadata_shape',
    );
    await expect(
      insertComment({
        metadata_json: { kind: 'graph_patch', patchVersion: 1, appliedRevisionNo: 2 },
      }),
    ).resolves.toBeUndefined();
  });

  it('requires a policy gap to be traceable to the eval run that found it', async () => {
    const complete = {
      kind: 'policy_gap',
      evalRunId: randomUUID(),
      failureKey: 'missing_coa_batch',
      agentVersionId: randomUUID(),
    };
    for (const missing of ['evalRunId', 'failureKey', 'agentVersionId'] as const) {
      const partial = { ...complete } as Record<string, unknown>;
      delete partial[missing];
      await expectPgError(insertComment({ metadata_json: partial }), 'ck_comments_metadata_shape');
    }
  });

  it('requires a review issue to name its key and its origin', async () => {
    await expectPgError(
      insertComment({ metadata_json: { kind: 'review_issue', issueKey: ISSUE } }),
      'ck_comments_metadata_shape',
    );
    // Only two origins exist, and the distinction matters: a deterministic finding is reproducible
    // and a model finding is not.
    await expectPgError(
      insertComment({
        metadata_json: { kind: 'review_issue', issueKey: ISSUE, origin: 'heuristic' },
      }),
      'ck_comments_metadata_shape',
    );
  });

  it('rejects metadata that is not an object at all', async () => {
    await expectPgError(insertComment({ metadata_json: '"reply"' }), 'ck_comments_metadata');
  });

  it('is satisfied by everything the comment RPCs write', async () => {
    await rpcAsUser(owner, 'reply_to_comment', [rootId, 'The forwarder always sends this.']);
    await rpcAsUser(owner, 'record_explicit_assumption', [rootId, 'A CoA is mandatory per batch.']);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ kind: string }>(
        `select metadata_json->>'kind' as kind from public.comments order by created_at`,
      ),
    );
    expect(rows.map((row) => row.kind)).toEqual(['review_issue', 'reply', 'assumption']);
  });
});
