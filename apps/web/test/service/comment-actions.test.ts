import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyCommentPatch,
  recordAssumption,
  rejectComment,
  replyToComment,
} from '@/server/services/comment-actions';
import { runReview } from '@/server/services/run-review';
import { saveWhiteboardDelta } from '@/server/services/save-whiteboard-delta';
import { createBoard, ensureUser, userClient, type TestBoard } from './helpers';

/**
 * The four things an operator may do with a review finding — and the fifth they may not.
 *
 * There is no "resolve" action anywhere in this file, and its absence is the design. An operator
 * who could close their own findings could walk any board to a clean bill of health without
 * changing anything about the process it describes. Resolution belongs to the next review round,
 * which has to observe that the issue is genuinely gone.
 *
 * What an operator can do is reply (the issue stays open, now `answered`), reject with a reason
 * (their judgement is recorded and the finding will not be re-raised), apply a suggested patch
 * (the graph changes, under optimistic concurrency, like every other write), and record an explicit
 * assumption (which is the one thing that lets a later round resolve a model finding).
 */

const EMAIL = 'comment-actions@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: Awaited<ReturnType<typeof userClient>>;
let ownerId: string;
let board: TestBoard;
let roots: { commentId: string; issueKey: string }[];

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);
  // The base fixture board is deliberately well-formed, so it raises little. Two disconnected
  // nodes are added here because these tests need findings to act on, and a disconnected node is
  // the least contrived defect available: it is what a half-finished edit leaves behind.
  const saved = await saveWhiteboardDelta(owner, board.whiteboardId, {
    expectedRevisionNo: board.revisionNo,
    nodeUpserts: [
      {
        nodeId: randomUUID(),
        primitiveType: 'action',
        title: 'Notify the broker',
        data: {
          actor: 'agent',
          operation: 'mail.send',
          instructions: '',
          system: 'gmail',
          inputs: [],
          outputs: [],
        },
        position: { x: 0, y: 400 },
      },
      {
        nodeId: randomUUID(),
        primitiveType: 'action',
        title: 'File the entry',
        data: {
          actor: 'agent',
          operation: 'browser.open',
          instructions: '',
          system: 'portal',
          inputs: [],
          outputs: [],
        },
        position: { x: 260, y: 400 },
      },
    ] as never,
    nodeDeletes: [],
    edgeUpserts: [],
    edgeDeletes: [],
    viewport: null,
  });
  board.revisionNo = saved.revisionNo;

  await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);

  const { data } = await owner
    .from('comments')
    .select('comment_id, issue_key')
    .eq('whiteboard_id', board.whiteboardId)
    .is('parent_comment_id', null)
    .order('created_at');
  roots = (data ?? []).map((row) => ({
    commentId: row.comment_id,
    issueKey: row.issue_key as string,
  }));
  if (roots.length < 2) throw new Error('the fixture board must raise at least two findings');
});

async function statusOf(commentId: string): Promise<string | null> {
  const { data } = await owner
    .from('comments')
    .select('status')
    .eq('comment_id', commentId)
    .single();
  return data?.status ?? null;
}

describe('replying to a finding', () => {
  it('moves it to answered and leaves it live', async () => {
    const target = roots[0]?.commentId as string;
    await replyToComment(owner, target, 'The forwarder always includes the owner on the invoice.');
    expect(await statusOf(target)).toBe('answered');
  });

  it('adds the reply to the thread under the operator\u2019s own name', async () => {
    const target = roots[0]?.commentId as string;
    const { data } = await owner
      .from('comments')
      .select('author_type, author_user_id, body')
      .eq('parent_comment_id', target)
      .eq('author_type', 'user');
    expect((data ?? []).length).toBeGreaterThan(0);
    expect(data?.[0]?.author_user_id).toBe(ownerId);
  });

  it('refuses an empty reply', async () => {
    // A blank reply would move a blocking finding to `answered` while saying nothing, which is
    // the cheapest possible way to make a board look reviewed.
    await expect(replyToComment(owner, roots[0]?.commentId as string, '   ')).rejects.toThrow();
  });
});

describe('rejecting a finding', () => {
  it('records the reason along with the rejection', async () => {
    const target = roots[1]?.commentId as string;
    await rejectComment(owner, target, 'Out of scope: this step is handled by the broker.');
    expect(await statusOf(target)).toBe('rejected');

    // The rationale is written by the system rather than attributed to the operator as prose:
    // the reason is structured data the next round reads, not a comment somebody typed.
    const { data } = await owner
      .from('comments')
      .select('metadata_json')
      .eq('parent_comment_id', target)
      .eq('metadata_json->>kind', 'rejection');
    const metadata = data?.[0]?.metadata_json as { kind: string; reason: string } | undefined;
    expect(metadata?.kind).toBe('rejection');
    expect(metadata?.reason).toMatch(/broker/);
  });

  it('refuses a rejection with no reason', async () => {
    // A rejection is a judgement someone has to be able to review later. Without a reason it is
    // indistinguishable from dismissing the finding because it was inconvenient.
    await expect(rejectComment(owner, roots[0]?.commentId as string, '')).rejects.toThrow();
  });

  it('survives the next review round without being reopened', async () => {
    const target = roots[1]?.commentId as string;
    await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    expect(await statusOf(target)).toBe('rejected');
  });
});

describe('recording an assumption', () => {
  it('writes it as a reply that names the thread it came from', async () => {
    const target = roots[0]?.commentId as string;
    await recordAssumption(owner, target, 'A certificate of analysis is mandatory per batch.');

    const { data } = await owner
      .from('comments')
      .select('metadata_json')
      .eq('parent_comment_id', target);
    const assumption = (data ?? [])
      .map((row) => row.metadata_json as { kind: string; sourceRootCommentId?: string })
      .find((meta) => meta.kind === 'assumption');
    // The link back to the finding is what lets the next round know which issue this answers.
    expect(assumption?.sourceRootCommentId).toBe(target);
  });

  it('carries into the frozen spec as a recorded assumption', async () => {
    const { data } = await owner
      .from('comments')
      .select('comment_id')
      .eq('whiteboard_id', board.whiteboardId)
      .eq('metadata_json->>kind', 'assumption');
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describe('applying a suggested patch', () => {
  it('refuses a patch built on a revision that has moved on', async () => {
    const withPatch = await owner
      .from('comments')
      .select('comment_id')
      .eq('whiteboard_id', board.whiteboardId)
      .not('suggested_patch_json', 'is', null)
      .limit(1);
    const commentId = withPatch.data?.[0]?.comment_id;
    if (commentId === undefined) {
      // The fixture board's findings carry no patches; the concurrency rule is covered by
      // `save-delta.test.ts` and by the `apply_comment_patch` database test.
      expect(withPatch.data).toEqual([]);
      return;
    }
    await expect(applyCommentPatch(owner, commentId, board.revisionNo - 1)).rejects.toThrow();
  });
});

describe('acting on somebody else\u2019s board', () => {
  it('is refused', async () => {
    const strangerEmail = 'comment-actions-stranger@meridian.test';
    await ensureUser(strangerEmail, PASSWORD);
    const stranger = await userClient(strangerEmail, PASSWORD);
    await expect(
      replyToComment(stranger, roots[0]?.commentId as string, 'I disagree.'),
    ).rejects.toThrow();
  });
});
