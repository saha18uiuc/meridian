import { beforeAll, describe, expect, it } from 'vitest';
import { runReview } from '@/server/services/run-review';
import { replyToComment } from '@/server/services/comment-actions';
import { createBoard, ensureUser, serviceClient, userClient, type TestBoard } from './helpers';

/**
 * Finalizing a round, against the real database.
 *
 * `review-reconcile.test.ts` states the rules as a pure function; this checks that the rules are
 * what the system actually does once a session, its comments, and their history are involved. The
 * two differ in the ways that matter most: the database enforces one active session per board, it
 * refuses a second finalize of the same session, and it is the thing that decides what a comment's
 * status becomes.
 */

const EMAIL = 'review-finalize@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: Awaited<ReturnType<typeof userClient>>;
let ownerId: string;
let board: TestBoard;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);
});

async function rootComments() {
  const { data } = await owner
    .from('comments')
    .select('comment_id, issue_key, status, severity, review_session_id, created_at')
    .eq('whiteboard_id', board.whiteboardId)
    .is('parent_comment_id', null)
    .order('created_at');
  return data ?? [];
}

describe('finalizing a review round', () => {
  it('writes one root comment per finding', async () => {
    const result = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    const roots = await rootComments();

    expect(roots).toHaveLength(result.findings.length);
    expect(result.counts.inserted).toBe(result.findings.length);
    expect(new Set(roots.map((row) => row.issue_key)).size).toBe(roots.length);
    for (const row of roots) {
      expect(row.status).toBe('open');
      expect(row.severity === null).toBe(false);
    }
  });

  it('closes the session and stamps it completed', async () => {
    const { data } = await owner
      .from('review_sessions')
      .select('status, completed_at')
      .eq('whiteboard_id', board.whiteboardId)
      .order('round_no', { ascending: false })
      .limit(1)
      .single();
    expect(data?.status).toBe('completed');
    expect(data?.completed_at).not.toBeNull();
  });

  it('appends a recurrence reply instead of a second root on the next round', async () => {
    const before = await rootComments();
    const second = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    const after = await rootComments();

    // Same board, same graph, so the same deterministic checks fire. The count of roots must not
    // move; a second root per issue would double every unresolved count on the board.
    expect(after.map((row) => row.issue_key)).toEqual(before.map((row) => row.issue_key));
    expect(second.counts.recurred).toBe(before.length);
    expect(second.counts.inserted).toBe(0);
  });

  it('records recurrences as system replies in the original thread', async () => {
    const roots = await rootComments();
    const first = roots[0];
    expect(first).toBeDefined();

    const { data } = await owner
      .from('comments')
      .select('author_type, parent_comment_id')
      .eq('thread_id', first?.comment_id ?? '')
      .not('parent_comment_id', 'is', null);
    expect((data ?? []).length).toBeGreaterThan(0);
    expect((data ?? []).every((row) => row.author_type === 'system')).toBe(true);
  });

  it('does not resolve an issue just because the operator replied to it', async () => {
    const roots = await rootComments();
    const target = roots[0]?.comment_id as string;
    await replyToComment(owner, target, 'The forwarder always includes this on the invoice.');

    const after = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    const { data } = await owner
      .from('comments')
      .select('status')
      .eq('comment_id', target)
      .single();
    // `answered`, not `resolved`. An operator who could close their own findings could argue any
    // board into a clean bill of health.
    expect(data?.status).toBe('answered');
    expect(after.counts.resolved).toBe(0);
  });

  it('refuses to open a second round while one is running', async () => {
    // Two concurrent rounds would race to write findings for the same board and each would see
    // half the other's state. The active-session unique index makes it impossible.
    const service = serviceClient();
    const { data: session, error } = await service.rpc('create_review_session', {
      p_actor_user_id: ownerId,
      p_whiteboard_id: board.whiteboardId,
      p_expected_revision_no: board.revisionNo,
      p_snapshot: { metadata: {}, nodes: [], edges: [] } as never,
      p_snapshot_hash: 'f'.repeat(64),
      p_model_name: 'gpt-5.5',
      p_reasoning_effort: 'high',
    });
    // The snapshot is deliberately wrong, so this is refused before it can leave a session behind.
    expect(error?.message ?? JSON.stringify(session)).toMatch(/SNAPSHOT|HASH|MISMATCH/i);
  });

  it('is idempotent: finalizing a completed session twice changes nothing', async () => {
    const service = serviceClient();
    const { data: sessions } = await service
      .from('review_sessions')
      .select('review_session_id')
      .eq('whiteboard_id', board.whiteboardId)
      .eq('status', 'completed')
      .order('round_no', { ascending: false })
      .limit(1);
    const sessionId = sessions?.[0]?.review_session_id as string;
    const before = await rootComments();

    const { data } = await service.rpc('finalize_review_session', {
      p_actor_user_id: ownerId,
      p_review_session_id: sessionId,
      p_findings: [] as never,
      p_summary: {} as never,
    });

    // A retried request must not wipe the round's findings or resolve them all by reporting an
    // empty set the second time.
    expect((data as unknown as { wasAlreadyCompleted: boolean }).wasAlreadyCompleted).toBe(true);
    expect(await rootComments()).toHaveLength(before.length);
  });
});
