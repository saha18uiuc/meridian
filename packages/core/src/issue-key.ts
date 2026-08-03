import type { AnchorType, CheckCode } from './schemas/review.js';

/**
 * `comments.issue_key` (§5.5.3) is derived once and stored, never recomputed at read time.
 * It is what lets round N+1 recognise that a finding is the *same* issue as round N, so replying
 * to it, rejecting it, or resolving it survives across rounds.
 *
 *   det:<checkCode>:<anchorType>:<anchorId ?? 'canvas'>:<anchorFieldPath ?? '-'>
 *   mod:<normalizedIssueCode>:<anchorType>:<anchorId ?? 'canvas'>:<anchorFieldPath ?? '-'>
 *
 * Both are pure functions of their inputs, so the same finding always yields the same key and a
 * materially different finding at the same anchor yields a different one.
 */

export interface IssueAnchor {
  anchorType: AnchorType;
  anchorId: string | null;
  anchorFieldPath: string | null;
}

function anchorSegments(anchor: IssueAnchor): string {
  const id = anchor.anchorId ?? 'canvas';
  const field = anchor.anchorFieldPath ?? '-';
  return `${anchor.anchorType}:${id}:${field}`;
}

/**
 * Keys are lowercased before they are stored.
 *
 * `ck_comments_issue_key_shape` admits only `[a-z0-9_:.-]`, and the two sources of a key do not
 * agree on case on their own: check codes are written `DISCONNECTED_NODE` and field paths are
 * written `maxAttempts`. Normalizing here rather than at each call site is what stops a key from
 * being valid in one round and rejected in the next depending on which check produced it.
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function deriveDeterministicIssueKey(checkCode: CheckCode, anchor: IssueAnchor): string {
  return normalizeKey(`det:${checkCode}:${anchorSegments(anchor)}`);
}

/**
 * The code is typed `string`, not `NormalizedIssueCode`, and deliberately so: the value comes back
 * from a model, and a key still has to be derivable for a code the enum has not heard of. Callers
 * that hold a known code lose nothing by passing it here.
 */
export function deriveModelIssueKey(normalizedIssueCode: string, anchor: IssueAnchor): string {
  return normalizeKey(`mod:${String(normalizedIssueCode).trim()}:${anchorSegments(anchor)}`);
}
