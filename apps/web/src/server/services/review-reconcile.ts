import 'server-only';

import type { Finding, RootCommentStatus } from '@meridian/core/schemas';

/**
 * The six reconciliation rules of §5.5.3, as a pure function so the interesting cases are
 * testable without a database. `finalize_review_session` performs the authoritative writes; this
 * exists so the service can report accurate counts and, crucially, so the "the model simply
 * forgot to repeat a finding" case is visibly *not* a resolution.
 */

export interface PreviousRoot {
  commentId: string;
  issueKey: string;
  status: RootCommentStatus;
}

export interface ReconcileResult {
  /** Findings with no live root — these become new root issues. */
  toInsert: Finding[];
  /** Findings whose issue already has a live root — these append a `system` recurrence reply. */
  toRecur: Finding[];
  /** Live `open`/`answered` roots that this round genuinely resolves. */
  toResolve: PreviousRoot[];
  /** Recurrences on roots the operator already rejected; recorded, never reopened. */
  recurredRejected: PreviousRoot[];
}

export function reconcile(
  previousRoots: readonly PreviousRoot[],
  newFindings: readonly Finding[],
  liveAssumptionRootIds: readonly string[],
  /** Issue keys whose deterministic check still fires, regardless of what the model said. */
  stillFiringDeterministicKeys: readonly string[] = [],
): ReconcileResult {
  const findingByKey = new Map<string, Finding>();
  for (const finding of newFindings) findingByKey.set(finding.issueKey, finding);

  const liveRoots = previousRoots.filter(
    (root) => root.status === 'open' || root.status === 'answered',
  );
  const rejectedRoots = previousRoots.filter((root) => root.status === 'rejected');
  const liveByKey = new Map(liveRoots.map((root) => [root.issueKey, root]));
  const rejectedByKey = new Map(rejectedRoots.map((root) => [root.issueKey, root]));
  const assumed = new Set(liveAssumptionRootIds);
  const stillFiring = new Set(stillFiringDeterministicKeys);

  const toInsert: Finding[] = [];
  const toRecur: Finding[] = [];
  const recurredRejected: PreviousRoot[] = [];

  for (const finding of newFindings) {
    const live = liveByKey.get(finding.issueKey);
    if (live !== undefined) {
      toRecur.push(finding);
      continue;
    }
    const rejected = rejectedByKey.get(finding.issueKey);
    if (rejected !== undefined) {
      // A rejected root is never auto-reopened; the recurrence is recorded instead.
      recurredRejected.push(rejected);
      continue;
    }
    toInsert.push(finding);
  }

  const toResolve = liveRoots.filter((root) => {
    if (findingByKey.has(root.issueKey)) return false;
    // Absence alone is not evidence. Resolution requires that the deterministic check has stopped
    // firing, or that an explicit assumption in the thread covers the issue.
    if (stillFiring.has(root.issueKey)) return false;
    if (root.issueKey.startsWith('mod:') && !assumed.has(root.commentId)) {
      // A model finding that merely went missing this round is only resolved when the operator
      // recorded an assumption; otherwise it stays live.
      return false;
    }
    return true;
  });

  return { toInsert, toRecur, toResolve, recurredRejected };
}
