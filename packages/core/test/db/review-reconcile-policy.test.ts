import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';
import { modelFinding, nodeFinding, reviewRound } from '../helpers/review.js';

/**
 * What a second review round is allowed to conclude about the first, asserted against the rows
 * `finalize_review_session` actually writes.
 *
 * The rule that matters is the one about absence. A model that does not repeat a finding has not
 * demonstrated that the problem is gone — it may have run out of attention, phrased the same
 * concern differently, or simply been unlucky. Treating silence as resolution would mean a board
 * could be cleaned up by re-running the review until the model got bored, which is the opposite of
 * what review is for.
 *
 * So resolution needs evidence, and which evidence depends on where the finding came from. A
 * deterministic check is not a matter of opinion, so its absence *is* the evidence. A model finding
 * resolves only once the operator has recorded an explicit assumption on its thread. A rejected
 * finding is never reopened either — the operator already ruled on it — but its recurrence is
 * recorded, because "we decided this was fine and it keeps coming back" is worth being able to see.
 *
 * These cases were previously stated against a pure TypeScript function whose output the review
 * service computed and then discarded, while the database resolved any root the round did not
 * mention. The policy and the writes have to be the same thing, so they are asserted here against
 * the transaction that owns them.
 */

const DET = 'det:missing_owner:node:action:1';
const DET_OTHER = 'det:unlabeled_branch:node:rule:2';
const MOD = 'mod:ambiguous_threshold:node:action:1';
const MOD_OTHER = 'mod:unspecified_error_handling:node:action:2';

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

interface RootRow {
  commentId: string;
  issueKey: string;
  status: string | null;
  resolvedAt: string | null;
}

/** Every root issue on the board, which is the state the next round reasons about. */
async function roots(): Promise<RootRow[]> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{
      comment_id: string;
      issue_key: string;
      status: string | null;
      resolved_at: string | null;
    }>(
      `select comment_id, issue_key, status, resolved_at
         from public.comments
        where parent_comment_id is null
        order by issue_key`,
    ),
  );
  return rows.map((row) => ({
    commentId: row.comment_id,
    issueKey: row.issue_key,
    status: row.status,
    resolvedAt: row.resolved_at,
  }));
}

async function rootFor(issueKey: string): Promise<RootRow> {
  const found = (await roots()).find((root) => root.issueKey === issueKey);
  if (found === undefined) throw new Error(`no root carries ${issueKey}`);
  return found;
}

async function statusOf(issueKey: string): Promise<string | null> {
  return (await rootFor(issueKey)).status;
}

/** How many replies hang off a thread, which is how a recurrence makes itself visible. */
async function replyCount(rootCommentId: string): Promise<number> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ count: string }>(
      'select count(*)::text as count from public.comments where parent_comment_id = $1',
      [rootCommentId],
    ),
  );
  return Number(rows[0]?.count ?? '0');
}

describe('a round that raises an issue', () => {
  it('inserts a finding nobody has seen before', async () => {
    const result = await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    expect(result).toMatchObject({ inserted: 1, recurred: 0, resolved: 0 });
    expect(await roots()).toMatchObject([{ issueKey: DET, status: 'open' }]);
  });

  it('records a recurrence rather than a duplicate when the issue is already open', async () => {
    // A second root for the same issue would double the unresolved count and make the thread
    // impossible to follow. The recurrence appends to the existing thread instead.
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);

    expect(second).toMatchObject({ inserted: 0, recurred: 1, resolved: 0 });
    const all = await roots();
    expect(all).toHaveLength(1);
    expect(await replyCount(all[0]?.commentId ?? '')).toBe(1);
  });

  it('treats an answered issue as still live', async () => {
    // Replying to a finding is not resolving it. If it were, an operator could clear any board by
    // typing a sentence under each issue.
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const root = await rootFor(DET);
    await rpcAsUser(owner, 'reply_to_comment', [root.commentId, 'The notify party is the broker.']);
    expect(await statusOf(DET)).toBe('answered');

    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    expect(second).toMatchObject({ recurred: 1, resolved: 0 });
    expect(await statusOf(DET)).toBe('answered');
  });

  it('never reopens a rejected finding, but does record that it recurred', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const root = await rootFor(DET);
    await rpcAsUser(owner, 'reject_comment', [root.commentId, 'Handled by the broker contract.']);
    expect(await statusOf(DET)).toBe('rejected');

    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    expect(second.recurredRejected).toEqual([root.commentId]);
    expect(await statusOf(DET)).toBe('rejected');
    // The recurrence is still written to the thread, which is what makes a repeatedly-dismissed
    // issue visible to whoever reads the board later.
    expect(await replyCount(root.commentId)).toBe(2);
  });
});

describe('a round that resolves an issue', () => {
  it('resolves a deterministic issue once its check stops firing', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const second = await reviewRound(owner, board.boardId, []);

    expect(second).toMatchObject({ resolved: 1 });
    const root = await rootFor(DET);
    expect(root.status).toBe('resolved');
    expect(root.resolvedAt).not.toBeNull();
  });

  it('refuses to resolve a deterministic issue whose check still fires', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);

    expect(second).toMatchObject({ resolved: 0 });
    expect(await statusOf(DET)).toBe('open');
  });

  it('refuses to resolve a model finding that merely went unmentioned', async () => {
    // This is the case the whole policy exists for. Silence from a model is not evidence, so the
    // root stays live and the board still shows the ambiguity nobody addressed.
    await reviewRound(owner, board.boardId, [modelFinding(board, MOD)]);
    const second = await reviewRound(owner, board.boardId, []);

    expect(second).toMatchObject({ resolved: 0 });
    const root = await rootFor(MOD);
    expect(root.status).toBe('open');
    expect(root.resolvedAt).toBeNull();
  });

  it('still refuses when the operator only replied to it', async () => {
    // A reply moves the root to `answered`, which is explicitly still unresolved. Only an
    // assumption is a recorded decision about what the ambiguity means.
    await reviewRound(owner, board.boardId, [modelFinding(board, MOD)]);
    const root = await rootFor(MOD);
    await rpcAsUser(owner, 'reply_to_comment', [
      root.commentId,
      'We usually just call the broker.',
    ]);

    const second = await reviewRound(owner, board.boardId, []);
    expect(second).toMatchObject({ resolved: 0 });
    expect(await statusOf(MOD)).toBe('answered');
  });

  it('resolves a model finding once the operator records an assumption for it', async () => {
    await reviewRound(owner, board.boardId, [modelFinding(board, MOD)]);
    const root = await rootFor(MOD);
    await rpcAsUser(owner, 'record_explicit_assumption', [
      root.commentId,
      'A quantity variance up to 2% is accepted without escalation.',
    ]);

    const second = await reviewRound(owner, board.boardId, []);
    expect(second).toMatchObject({ resolved: 1 });
    expect(await statusOf(MOD)).toBe('resolved');
  });

  it('does not let an assumption on one thread resolve another', async () => {
    await reviewRound(owner, board.boardId, [
      modelFinding(board, MOD),
      modelFinding(board, MOD_OTHER),
    ]);
    const root = await rootFor(MOD);
    await rpcAsUser(owner, 'record_explicit_assumption', [root.commentId, 'Two percent.']);

    const second = await reviewRound(owner, board.boardId, []);
    expect(second).toMatchObject({ resolved: 1 });
    expect(await statusOf(MOD)).toBe('resolved');
    expect(await statusOf(MOD_OTHER)).toBe('open');
  });

  it('leaves an already-resolved root alone', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    await reviewRound(owner, board.boardId, []);
    const resolvedAt = (await rootFor(DET)).resolvedAt;

    const third = await reviewRound(owner, board.boardId, []);
    expect(third).toMatchObject({ resolved: 0 });
    const root = await rootFor(DET);
    expect(root.status).toBe('resolved');
    expect(root.resolvedAt).toEqual(resolvedAt);
  });

  it('handles a round that both resolves one issue and raises another', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET)]);
    const second = await reviewRound(owner, board.boardId, [nodeFinding(board, DET_OTHER)]);

    expect(second).toMatchObject({ inserted: 1, resolved: 1 });
    expect(await statusOf(DET)).toBe('resolved');
    expect(await statusOf(DET_OTHER)).toBe('open');
  });

  it('classifies every finding exactly once', async () => {
    await reviewRound(owner, board.boardId, [nodeFinding(board, DET), modelFinding(board, MOD)]);
    const rejected = await rootFor(MOD);
    await rpcAsUser(owner, 'reject_comment', [rejected.commentId, 'Not a concern for this lane.']);

    const findings = [
      nodeFinding(board, DET),
      modelFinding(board, MOD),
      nodeFinding(board, DET_OTHER),
    ];
    const second = await reviewRound(owner, board.boardId, findings);

    // Every finding is either a fresh insert or a recurrence on an existing root, never both and
    // never neither. `recurredRejected` names a subset of the recurrences rather than a third
    // bucket, because nothing happened to those roots beyond being written to.
    expect((second.inserted ?? 0) + (second.recurred ?? 0)).toBe(findings.length);
    expect(second.recurredRejected).toEqual([rejected.commentId]);
  });
});
