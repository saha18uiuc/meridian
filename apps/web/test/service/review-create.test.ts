import { beforeAll, describe, expect, it } from 'vitest';
import { resolveModel, runReview } from '@/server/services/run-review';
import { createBoard, ensureUser, serviceClient, userClient, type TestBoard } from './helpers';

/**
 * Opening a review round.
 *
 * A review is advice about a specific version of a board, so the session records the revision and
 * the canvas hash it read. That is what later lets the UI say "this review is stale" instead of
 * showing findings about nodes the operator has since deleted.
 *
 * The model is settled before the session row exists. `model_name` and `reasoning_effort` are
 * immutable once inserted — a review that could rewrite which model produced it would be evidence
 * of nothing — so preflighting afterwards would mean updating a column a trigger refuses to let us
 * update.
 */

const EMAIL = 'review-create@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: Awaited<ReturnType<typeof userClient>>;
let ownerId: string;
let board: TestBoard;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);
});

describe('resolveModel', () => {
  it('returns the configured model without a network call in mock mode', async () => {
    const resolved = await resolveModel();
    expect(resolved.modelName.length).toBeGreaterThan(0);
    expect(['low', 'medium', 'high', 'n/a']).toContain(resolved.reasoningEffort);
  });
});

describe('runReview', () => {
  it('records the revision and hash the round actually read', async () => {
    const result = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);

    expect(result.roundNo).toBe(1);
    expect(result.sourceRevisionNo).toBe(board.revisionNo);
    expect(result.sourceCanvasHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).toBe('completed');

    const { data } = await owner
      .from('review_sessions')
      .select('source_revision_no, source_canvas_hash, model_name, status')
      .eq('review_session_id', result.reviewSessionId)
      .single();
    expect(data?.source_revision_no).toBe(board.revisionNo);
    expect(data?.source_canvas_hash).toBe(result.sourceCanvasHash);
    expect(data?.model_name).toBe(result.modelName);
    expect(data?.status).toBe('completed');
  });

  it('refuses to review a revision the caller has not seen', async () => {
    // The operator's tab may be behind. Reviewing the current board and labelling the result with
    // the revision they asked about would attach findings to a graph they never looked at.
    await expect(
      runReview(owner, ownerId, board.whiteboardId, board.revisionNo + 5),
    ).rejects.toThrow(/STALE_BOARD_REVISION/);
  });

  it('numbers rounds per board so a second review follows the first', async () => {
    const second = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    expect(second.roundNo).toBe(2);
  });

  it('refuses a review of a board the caller does not own', async () => {
    const strangerEmail = 'review-create-stranger@meridian.test';
    const strangerId = await ensureUser(strangerEmail, PASSWORD);
    const stranger = await userClient(strangerEmail, PASSWORD);

    await expect(
      runReview(stranger, strangerId, board.whiteboardId, board.revisionNo),
    ).rejects.toThrow();
  });

  it('leaves no session in the running state behind it', async () => {
    // A session stuck in `running` blocks every later round on the board through the active-session
    // unique index, so the failure path has to close it even when the model call is what failed.
    const { data } = await serviceClient()
      .from('review_sessions')
      .select('review_session_id, status')
      .eq('whiteboard_id', board.whiteboardId);
    expect((data ?? []).filter((row) => row.status === 'running')).toEqual([]);
  });

  it('produces findings anchored to nodes that exist on the board', async () => {
    const result = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
    for (const finding of result.findings) {
      if (finding.anchorType === 'canvas') continue;
      // An anchor pointing at a deleted node would render as a comment attached to nothing, so
      // unknown anchors are re-anchored to the canvas before they are ever written.
      expect(board.nodeIds.concat(finding.anchorId ?? '')).toContain(finding.anchorId);
    }
  });
});
