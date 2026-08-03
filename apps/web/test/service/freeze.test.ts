import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@meridian/core/database';
import { FreezeRequestSchema } from '@meridian/core/schemas';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBoard, ensureUser, userClient, type TestBoard } from './helpers';
import type * as ServiceClientModule from '@/server/supabase/service-client';

/**
 * Freezing a spec, against the real database.
 *
 * Freeze is where the board stops being a drawing and becomes the thing code is generated from, so
 * the interesting cases are all about what it refuses to do quietly: it will not freeze over
 * unresolved blockers without being told to, it will not freeze a second identical spec, and it
 * will not freeze a snapshot the board has already moved past. Each of those is a separate way to
 * end up with generated code whose spec nobody actually agreed to.
 */

const EMAIL = 'freeze-service@meridian.test';
const PASSWORD = 'meridian-test-password';

// `freezeSpec` reaches for the service client itself, which gives the injected-edit test its seam:
// the mock wraps the real client so the RPC can be observed and, once, raced.
const rpcCalls: string[] = [];
let beforeFreezeRpc: (() => Promise<void>) | null = null;

vi.mock('@/server/supabase/service-client', async () => {
  const actual = await vi.importActual<typeof ServiceClientModule>(
    '@/server/supabase/service-client',
  );
  return {
    createServiceClient(): SupabaseClient<Database> {
      const client = actual.createServiceClient();
      const rpc = client.rpc.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).rpc = async (name: string, args: unknown) => {
        rpcCalls.push(name);
        if (name === 'freeze_whiteboard_spec' && beforeFreezeRpc !== null) {
          const hook = beforeFreezeRpc;
          beforeFreezeRpc = null;
          await hook();
        }
        return rpc(name as never, args as never);
      };
      return client;
    },
  };
});

const { freezeSpec, freezePreview } = await import('@/server/services/freeze-spec');
const { runReview } = await import('@/server/services/run-review');
const { rejectComment } = await import('@/server/services/comment-actions');
const { saveWhiteboardDelta } = await import('@/server/services/save-whiteboard-delta');

let owner: SupabaseClient<Database>;
let ownerId: string;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
});

afterEach(() => {
  rpcCalls.length = 0;
  beforeFreezeRpc = null;
});

/**
 * A board that has been reviewed and settled: the review has run, so `last_reviewed_revision_no` is
 * current, and every blocking finding has been rejected with a reason.
 *
 * The reviewer raises a blocking question about error handling on any board that contains an
 * action, so "settled" has to mean answered rather than never asked. Rejecting is the honest way to
 * get there: it is the operator saying the question does not apply, which is a decision on record.
 */
async function reviewedBoard(): Promise<TestBoard> {
  const board = await createBoard(owner);
  await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);

  const { data: roots } = await owner
    .from('comments')
    .select('comment_id')
    .eq('whiteboard_id', board.whiteboardId)
    .is('parent_comment_id', null)
    .eq('severity', 'blocking');
  for (const root of roots ?? []) {
    await rejectComment(
      owner,
      root.comment_id,
      'Handled by the exception queue, out of scope here.',
    );
  }
  return board;
}

/** Append a disconnected action, which both moves the revision and creates a blocking finding. */
async function addLooseNode(board: TestBoard, revisionNo: number): Promise<number> {
  const result = await saveWhiteboardDelta(owner, board.whiteboardId, {
    expectedRevisionNo: revisionNo,
    nodeUpserts: [
      {
        nodeId: randomUUID(),
        primitiveType: 'action',
        title: `Loose step ${randomUUID().slice(0, 6)}`,
        data: {
          actor: 'agent',
          operation: 'notify',
          instructions: 'Tell somebody.',
          system: 'gmail',
          inputs: [],
          outputs: [],
        },
        position: { x: 900, y: 300 },
      },
    ],
    nodeDeletes: [],
    edgeUpserts: [],
    edgeDeletes: [],
    viewport: null,
  });
  return result.revisionNo;
}

describe('the freeze request contract', () => {
  it('has no field through which a caller could supply an artifact', () => {
    // The spec and its hash are server-derived. A request shape that accepted them would let a
    // client freeze a spec that never came from the board's own rows.
    for (const forged of [
      { specJson: {} },
      { specHash: 'a'.repeat(64) },
      { sourceCanvasJson: {} },
      { sourceCanvasHash: 'b'.repeat(64) },
    ]) {
      const parsed = FreezeRequestSchema.safeParse({
        expectedRevisionNo: 1,
        acknowledgeUnresolvedBlockers: false,
        acknowledgeStaleReview: false,
        ...forged,
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('freezing a clean board', () => {
  it('binds the spec to the revision and canvas hash it was compiled from', async () => {
    const board = await reviewedBoard();
    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: board.revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: false,
    });

    expect(frozen.sourceRevisionNo).toBe(board.revisionNo);
    expect(frozen.specVersion).toBe(1);
    expect(frozen.warnings).toEqual([]);

    const { data } = await owner
      .from('frozen_specs')
      .select('spec_hash, source_canvas_hash, source_revision_no, spec_version')
      .eq('spec_id', frozen.specId)
      .single();
    expect(data?.spec_hash).toBe(frozen.specHash);
    expect(data?.source_canvas_hash).toBe(frozen.sourceCanvasHash);
    expect(data?.source_revision_no).toBe(board.revisionNo);
  });

  it('refuses a second freeze of an unchanged board', async () => {
    const board = await reviewedBoard();
    const request = {
      expectedRevisionNo: board.revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: false,
    };
    await freezeSpec(owner, ownerId, board.whiteboardId, request);

    // Identical board, identical spec, identical hash. Allowing this would give two spec IDs the
    // same content, and every downstream question about "which spec is this agent built from"
    // would then have two answers.
    await expect(freezeSpec(owner, ownerId, board.whiteboardId, request)).rejects.toThrow(
      /SPEC_ALREADY_FROZEN/,
    );
  });

  it('numbers the second spec of a board after the first', async () => {
    const board = await reviewedBoard();
    await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: board.revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: false,
    });

    const revisionNo = await addLooseNode(board, board.revisionNo);
    const second = await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: revisionNo,
      acknowledgeUnresolvedBlockers: true,
      acknowledgeStaleReview: true,
    });
    expect(second.specVersion).toBe(2);
  });
});

describe('unresolved blockers', () => {
  it('warns and requires acknowledgement, but does not block', async () => {
    const board = await createBoard(owner);
    const revisionNo = await addLooseNode(board, board.revisionNo);
    const review = await runReview(owner, ownerId, board.whiteboardId, revisionNo);
    expect(review.findings.some((finding) => finding.severity === 'blocking')).toBe(true);

    const request = {
      expectedRevisionNo: revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: false,
    };
    await expect(freezeSpec(owner, ownerId, board.whiteboardId, request)).rejects.toThrow(
      /UNRESOLVED_BLOCKERS/,
    );

    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      ...request,
      acknowledgeUnresolvedBlockers: true,
    });
    // The operator decides; the system records what they decided over.
    expect(frozen.blockerCount).toBeGreaterThan(0);
    expect(frozen.unresolvedCommentIds.length).toBeGreaterThan(0);
    expect(frozen.warnings.join(' ')).toMatch(/unresolved blocking/i);
  });

  it('does not count a rejected root as unresolved', async () => {
    const board = await createBoard(owner);
    const revisionNo = await addLooseNode(board, board.revisionNo);
    await runReview(owner, ownerId, board.whiteboardId, revisionNo);

    const { data: roots } = await owner
      .from('comments')
      .select('comment_id, severity')
      .eq('whiteboard_id', board.whiteboardId)
      .is('parent_comment_id', null);
    for (const root of roots ?? []) {
      await rejectComment(owner, root.comment_id, 'This step is handled outside the agent.');
    }

    const preview = await freezePreview(owner, board.whiteboardId);
    expect(preview.unresolvedCommentIds).toEqual([]);
    expect(preview.dismissedComments.length).toBe((roots ?? []).length);

    // No acknowledgement flag anywhere: a rejected finding is a decision, not an open question.
    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: false,
    });
    expect(frozen.blockerCount).toBe(0);
    expect(frozen.dismissedCommentIds.length).toBe((roots ?? []).length);
  });
});

describe('a stale review', () => {
  it('warns and requires its own acknowledgement, separate from blockers', async () => {
    const board = await reviewedBoard();
    const revisionNo = await addLooseNode(board, board.revisionNo);

    const request = {
      expectedRevisionNo: revisionNo,
      acknowledgeUnresolvedBlockers: true,
      acknowledgeStaleReview: false,
    };
    await expect(freezeSpec(owner, ownerId, board.whiteboardId, request)).rejects.toThrow(
      /STALE_REVIEW/,
    );

    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      ...request,
      acknowledgeStaleReview: true,
    });
    expect(frozen.warnings.join(' ')).toMatch(/revision\(s\) behind/);
  });

  it('names a board that was never reviewed at all', async () => {
    const board = await createBoard(owner);
    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: board.revisionNo,
      acknowledgeUnresolvedBlockers: false,
      acknowledgeStaleReview: true,
    });
    expect(frozen.warnings.join(' ')).toMatch(/without ever running a review/i);
  });
});

describe('a board that moves underneath the freeze', () => {
  it('rejects a request whose expected revision is already behind', async () => {
    const board = await reviewedBoard();
    await expect(
      freezeSpec(owner, ownerId, board.whiteboardId, {
        expectedRevisionNo: board.revisionNo - 1,
        acknowledgeUnresolvedBlockers: true,
        acknowledgeStaleReview: true,
      }),
    ).rejects.toThrow(/STALE_BOARD_REVISION/);
  });

  it('recompiles exactly once when an edit lands between compile and freeze', async () => {
    const board = await reviewedBoard();
    let editedRevisionNo = 0;

    // Compilation happens outside the lock, so there is a real window here. The hook lands an edit
    // inside it; the RPC must then refuse the stale snapshot rather than freeze it.
    beforeFreezeRpc = async () => {
      editedRevisionNo = await addLooseNode(board, board.revisionNo);
    };

    const frozen = await freezeSpec(owner, ownerId, board.whiteboardId, {
      expectedRevisionNo: board.revisionNo,
      acknowledgeUnresolvedBlockers: true,
      acknowledgeStaleReview: true,
    });

    const freezeAttempts = rpcCalls.filter((name) => name === 'freeze_whiteboard_spec');
    expect(freezeAttempts).toHaveLength(2);
    // The spec that survived describes the board as it is now, not as it was when compilation began.
    expect(frozen.sourceRevisionNo).toBe(editedRevisionNo);

    const { data } = await owner
      .from('frozen_specs')
      .select('spec_id')
      .eq('whiteboard_id', board.whiteboardId);
    expect(data ?? []).toHaveLength(1);
  });
});

describe('another user', () => {
  it('cannot freeze a board they do not own', async () => {
    const board = await reviewedBoard();
    const intruderId = await ensureUser('freeze-intruder@meridian.test', PASSWORD);
    const intruder = await userClient('freeze-intruder@meridian.test', PASSWORD);

    await expect(
      freezeSpec(intruder, intruderId, board.whiteboardId, {
        expectedRevisionNo: board.revisionNo,
        acknowledgeUnresolvedBlockers: true,
        acknowledgeStaleReview: true,
      }),
    ).rejects.toThrow(/WHITEBOARD_NOT_FOUND_OR_FORBIDDEN/);
  });
});
