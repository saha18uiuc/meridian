import 'server-only';

import { randomUUID } from 'node:crypto';
import { compileSpec, deriveSpecHash, type CompilerKnownGap } from '@meridian/core';
import type { Database, Json } from '@meridian/core/database';
import type { FreezeRequest, FreezeResponse } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CompilationFailedError } from '@/server/http/error-map';
import {
  dismissedRoots,
  listBoardComments,
  listLiveAssumptions,
  unresolvedRoots,
} from '@/server/repositories/comments';
import { listReviewSessions } from '@/server/repositories/reviews';
import { createServiceClient } from '@/server/supabase/service-client';
import { assembleSnapshot } from '@/server/services/assemble-snapshot';
import { assertOwner, ownerOfBoard } from '@/server/services/ownership';

type Client = SupabaseClient<Database>;

const MAX_ATTEMPTS = 3;

/**
 * Compile outside the lock, then freeze inside it. If the board moved between the two, the RPC
 * refuses and we recompile — bounded — rather than freezing a spec that describes a revision
 * nobody can point at any more.
 */
export async function freezeSpec(
  userClient: Client,
  userId: string,
  whiteboardId: string,
  request: FreezeRequest,
): Promise<FreezeResponse> {
  assertOwner(await ownerOfBoard(userClient, whiteboardId), userId, 'WHITEBOARD');
  const service = createServiceClient();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const assembled = await assembleSnapshot(userClient, whiteboardId);
    if (attempt === 0 && assembled.revisionNo !== request.expectedRevisionNo) {
      throw new Error(
        `STALE_BOARD_REVISION: expected=${request.expectedRevisionNo} current=${assembled.revisionNo}`,
      );
    }

    const comments = await listBoardComments(userClient, whiteboardId);
    const unresolved = unresolvedRoots(comments);
    const dismissed = dismissedRoots(comments);
    const blockers = unresolved.filter((c) => c.severity === 'blocking');
    const assumptions = await listLiveAssumptions(userClient, whiteboardId);
    const sessions = await listReviewSessions(userClient, whiteboardId, 200);
    const specVersion = await nextSpecVersion(userClient, whiteboardId);

    const knownGaps: CompilerKnownGap[] = [
      ...unresolved.map((c) => ({
        text: c.body,
        severity: c.severity ?? 'non_blocking',
        sourceCommentId: c.commentId,
      })),
      ...comments
        .filter(
          (c) =>
            c.parentCommentId === null &&
            (c.metadataJson as { kind?: string }).kind === 'policy_gap',
        )
        .map((c) => ({
          text: c.body,
          severity: c.severity ?? 'blocking',
          sourceCommentId: c.commentId,
        })),
    ];

    const specId = randomUUID();
    const compiled = compileSpec({
      graph: assembled.snapshot,
      specId,
      specVersion,
      name: assembled.title,
      canvasHash: assembled.hash,
      reviewSessionIds: sessions
        .filter((s) => s.status === 'completed')
        .map((s) => s.reviewSessionId),
      frozenAt: new Date().toISOString(),
      acknowledgedUnresolvedBlockers: request.acknowledgeUnresolvedBlockers,
      acknowledgedStaleReview: request.acknowledgeStaleReview,
      assumptions: assumptions.map((a) => ({
        assumptionText: a.assumptionText,
        sourceRootCommentId: a.sourceRootCommentId,
      })),
      knownGaps,
    });
    if ('errors' in compiled) throw new CompilationFailedError(compiled.errors);

    const specHash = deriveSpecHash(compiled.specJson);

    const { data, error } = await service.rpc('freeze_whiteboard_spec', {
      p_actor_user_id: userId,
      p_whiteboard_id: whiteboardId,
      p_expected_revision_no: assembled.revisionNo,
      p_canvas_json: assembled.snapshot as unknown as Json,
      p_canvas_hash: assembled.hash,
      p_spec_json: compiled.specJson as unknown as Json,
      p_spec_hash: specHash,
      p_unresolved_comment_ids: unresolved.map((c) => c.commentId),
      p_ack_blockers: request.acknowledgeUnresolvedBlockers,
      p_ack_stale_review: request.acknowledgeStaleReview,
    });

    if (error !== null) {
      if (error.message.startsWith('BOARD_CHANGED_DURING_FREEZE')) {
        lastError = new Error(error.message);
        continue;
      }
      if (error.message.includes('uq_frozen_specs_spec_hash')) {
        throw new Error(`SPEC_ALREADY_FROZEN: ${specHash}`);
      }
      throw new Error(error.message);
    }

    const result = (data ?? {}) as Record<string, unknown>;
    const warnings: string[] = [];
    if (blockers.length > 0) {
      warnings.push(
        `Frozen with ${blockers.length} unresolved blocking comment(s), acknowledged by the operator.`,
      );
    }
    if (assembled.lastReviewedRevisionNo !== assembled.revisionNo) {
      warnings.push(
        assembled.lastReviewedRevisionNo === null
          ? 'Frozen without ever running a review, acknowledged by the operator.'
          : `Frozen while the last review was ${assembled.revisionNo - assembled.lastReviewedRevisionNo} revision(s) behind, acknowledged by the operator.`,
      );
    }

    return {
      specId: result['specId'] as string,
      specVersion: result['specVersion'] as number,
      specHash,
      sourceCanvasHash: assembled.hash,
      sourceRevisionNo: result['sourceRevisionNo'] as number,
      unresolvedCommentIds: unresolved.map((c) => c.commentId),
      dismissedCommentIds: dismissed.map((c) => c.commentId),
      blockerCount: (result['blockerCount'] as number | undefined) ?? blockers.length,
      warnings,
    };
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('BOARD_CHANGED_DURING_FREEZE: retries exhausted');
}

async function nextSpecVersion(client: Client, whiteboardId: string): Promise<number> {
  const { data, error } = await client
    .from('frozen_specs')
    .select('spec_version')
    .eq('whiteboard_id', whiteboardId)
    .order('spec_version', { ascending: false })
    .limit(1);
  if (error !== null) throw new Error(error.message);
  return ((data ?? [])[0]?.spec_version ?? 0) + 1;
}

/** What the freeze dialog needs in order to show the right number of checkboxes, and no more. */
export async function freezePreview(userClient: Client, whiteboardId: string) {
  const [assembled, comments] = await Promise.all([
    assembleSnapshot(userClient, whiteboardId),
    listBoardComments(userClient, whiteboardId),
  ]);
  const unresolved = unresolvedRoots(comments);
  return {
    revisionNo: assembled.revisionNo,
    lastReviewedRevisionNo: assembled.lastReviewedRevisionNo,
    unresolvedCommentIds: unresolved.map((c) => c.commentId),
    blockingComments: unresolved
      .filter((c) => c.severity === 'blocking')
      .map((c) => ({ commentId: c.commentId, body: c.body })),
    dismissedComments: dismissedRoots(comments).map((c) => ({
      commentId: c.commentId,
      body: c.body,
    })),
  };
}
