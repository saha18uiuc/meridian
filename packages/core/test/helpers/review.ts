import { buildSnapshot, rpcAsService, type SeededBoard } from './db.js';

/**
 * Fixtures for the review round-trip.
 *
 * `create_review_session` and `finalize_review_session` are service-role-only (A21), so these
 * helpers call them exactly the way the Next.js server does: with the graph assembled and hashed
 * on the trusted side and the human's identity passed explicitly as `p_actor_user_id`.
 */

export interface Finding {
  issueKey: string;
  severity: 'blocking' | 'non_blocking';
  body: string;
  anchorType: 'node' | 'edge' | 'canvas';
  anchorId?: string | null;
  anchorFieldPath?: string | null;
  origin?: 'deterministic' | 'model';
  checkCode?: string | null;
  suggestedPatch?: Record<string, unknown> | null;
}

export interface ReviewSession {
  reviewSessionId: string;
  roundNo: number;
  sourceRevisionNo: number;
}

export async function startReview(owner: string, boardId: string): Promise<ReviewSession> {
  const { snapshot, hash, revisionNo } = await buildSnapshot(boardId);
  return rpcAsService<ReviewSession>('create_review_session', [
    owner,
    boardId,
    revisionNo,
    JSON.stringify(snapshot),
    hash,
    'gpt-5.5',
    'high',
  ]);
}

export interface FinalizeResult {
  reviewSessionId: string;
  wasAlreadyCompleted: boolean;
  inserted?: number;
  recurred?: number;
  resolved?: number;
}

export function finalizeReview(
  owner: string,
  reviewSessionId: string,
  findings: Finding[],
  summary: Record<string, unknown> = {},
): Promise<FinalizeResult> {
  return rpcAsService<FinalizeResult>('finalize_review_session', [
    owner,
    reviewSessionId,
    JSON.stringify(findings.map((f) => ({ origin: 'deterministic', ...f }))),
    JSON.stringify(summary),
  ]);
}

/** Run one full round against the board's current state and return what it produced. */
export async function reviewRound(
  owner: string,
  boardId: string,
  findings: Finding[],
): Promise<FinalizeResult> {
  const session = await startReview(owner, boardId);
  return finalizeReview(owner, session.reviewSessionId, findings);
}

/** A deterministic finding anchored to a node that the seeded board really has. */
export function nodeFinding(
  board: SeededBoard,
  issueKey: string,
  severity: Finding['severity'] = 'blocking',
): Finding {
  return {
    issueKey,
    severity,
    body: `Issue ${issueKey}`,
    anchorType: 'node',
    anchorId: board.actionNodeId,
    origin: 'deterministic',
  };
}
