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
import { finalizeReview, nodeFinding, reviewRound, startReview } from '../helpers/review.js';

/**
 * Issue identity across rounds (A26).
 *
 * An issue is identified by its `issue_key`, not by the round that found it. That single decision
 * is what turns a repeated review from a comment generator into a conversation: the second sighting
 * of the same problem lands as a reply on the thread the operator has already been arguing with,
 * and a problem that stops being reported is resolved rather than left to rot.
 */

const ISSUE = 'det:missing_owner:node:action:1';

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

interface CommentRow {
  comment_id: string;
  thread_id: string;
  parent_comment_id: string | null;
  status: string | null;
  issue_key: string | null;
  body: string;
  author_type: string;
}

async function comments(): Promise<CommentRow[]> {
  const { rows } = await asPostgres(async (client) =>
    client.query<CommentRow>(
      `select comment_id, thread_id, parent_comment_id, status, issue_key, body, author_type
         from public.comments order by created_at, comment_id`,
    ),
  );
  return rows;
}

const roots = (all: CommentRow[]): CommentRow[] => all.filter((c) => c.parent_comment_id === null);

describe('a recurring issue', () => {
  it('becomes a reply on the existing thread rather than a second root', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);

    expect(second).toMatchObject({ inserted: 0, recurred: 1 });
    const all = await comments();
    expect(roots(all)).toHaveLength(1);
    expect(all.filter((c) => c.parent_comment_id !== null)).toHaveLength(1);
  });

  it('names the round it recurred in, so the thread reads as a history', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);

    const reply = (await comments()).find((c) => c.parent_comment_id !== null);
    expect(reply?.body).toMatch(/^Recurred in round 2: /);
    expect(reply?.author_type).toBe('system');
  });

  it('keeps a rejected root rejected instead of reopening the argument', async () => {
    const first = await startReview(owner, board.boardId);
    await finalizeReview(owner, first.reviewSessionId, [nodeFinding(board, ISSUE)]);
    const root = roots(await comments())[0] as CommentRow;
    await rpcAsUser(owner, 'reject_comment', [root.comment_id, 'Our carrier confirms verbally.']);

    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);

    const after = (await comments()).find((c) => c.comment_id === root.comment_id);
    expect(after?.status).toBe('rejected');
    expect(roots(await comments())).toHaveLength(1);
  });

  it('does not resolve a rejected root when the issue stops being reported', async () => {
    const first = await startReview(owner, board.boardId);
    await finalizeReview(owner, first.reviewSessionId, [nodeFinding(board, ISSUE)]);
    const root = roots(await comments())[0] as CommentRow;
    await rpcAsUser(owner, 'reject_comment', [root.comment_id, 'Deliberate policy.']);

    // A rejected issue is a decision the operator already made. Silently flipping it to `resolved`
    // would erase that decision and make the next recurrence look new.
    const second = await reviewRound(owner, board.boardId, []);
    expect(second.resolved).toBe(0);
    expect((await comments()).find((c) => c.comment_id === root.comment_id)?.status).toBe(
      'rejected',
    );
  });
});

describe('an issue that stops being reported', () => {
  it('is resolved when the round that omits it completes', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    const second = await reviewRound(owner, board.boardId, []);
    expect(second.resolved).toBe(1);
    expect(roots(await comments())[0]?.status).toBe('resolved');
  });

  it('is resolved even after the operator replied to it', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    const root = roots(await comments())[0] as CommentRow;
    await rpcAsUser(owner, 'reply_to_comment', [root.comment_id, 'Fixed by adding an owner.']);
    expect((await comments()).find((c) => c.comment_id === root.comment_id)?.status).toBe(
      'answered',
    );

    const second = await reviewRound(owner, board.boardId, []);
    expect(second.resolved).toBe(1);
  });

  it('frees the live-issue slot, so a later recurrence opens a fresh root', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    await reviewRound(owner, board.boardId, []);
    const third = await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);

    expect(third).toMatchObject({ inserted: 1, recurred: 0 });
    const all = roots(await comments());
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.status).sort()).toEqual(['open', 'resolved']);
  });
});

describe('uq_comments_live_issue', () => {
  it('makes a second live root for the same issue key unrepresentable', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, ISSUE)]);
    const root = roots(await comments())[0] as CommentRow;

    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.comments
             (comment_id, whiteboard_id, review_session_id, thread_id, author_type, body,
              anchor_type, anchor_id, status, severity, issue_key, metadata_json)
           select gen_random_uuid(), c.whiteboard_id, c.review_session_id, gen_random_uuid(), 'ai',
                  'duplicate', 'canvas', null, 'open', 'blocking', c.issue_key,
                  '{"kind":"review_issue","issueKey":"x","origin":"model"}'::jsonb
             from public.comments c where c.comment_id = $1`,
          [root.comment_id],
        ),
      ),
      'ck_comments_root_thread_identity',
    );
  });
});

describe('issue keys within one round', () => {
  it('collapse a duplicated finding into one root, because identity is the key not the sighting', async () => {
    const session = await startReview(owner, board.boardId);
    const result = await finalizeReview(owner, session.reviewSessionId, [
      nodeFinding(board, ISSUE),
      nodeFinding(board, ISSUE),
    ]);
    // The loop looks up a live root before inserting, so the second copy takes the recurrence
    // branch. `uq_comments_session_issue` is the backstop that would catch it if it did not.
    expect(result).toMatchObject({ inserted: 1, recurred: 1 });
    expect(roots(await comments())).toHaveLength(1);
  });
});
