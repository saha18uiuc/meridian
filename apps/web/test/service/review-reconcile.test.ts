import { describe, expect, it } from 'vitest';
import type { Finding } from '@meridian/core/schemas';
import { reconcile, type PreviousRoot } from '@/server/services/review-reconcile';

/**
 * What a second review round is allowed to conclude about the first.
 *
 * The rule that matters is the one about absence. A model that does not repeat a finding has not
 * demonstrated that the problem is gone — it may have run out of attention, or phrased the same
 * concern differently, or simply been unlucky. Treating silence as resolution would mean a board
 * could be cleaned up by re-running the review until the model got bored, which is the opposite of
 * what review is for.
 *
 * So resolution needs evidence: either the deterministic check that raised it has stopped firing,
 * or the operator has recorded an explicit assumption that answers it. A rejected finding is never
 * reopened either — the operator already ruled on it — but its recurrence is recorded, because
 * "we decided this was fine and it keeps coming back" is worth being able to see.
 *
 * This is a pure function precisely so these cases can be stated plainly. The authoritative writes
 * happen in `finalize_review_session`; this is what lets the service report honest counts.
 */

function finding(issueKey: string, severity: Finding['severity'] = 'blocking'): Finding {
  const isDeterministic = issueKey.startsWith('det:');
  return {
    issueKey,
    severity,
    body: `Issue ${issueKey}`,
    anchorType: 'canvas',
    anchorId: null,
    anchorFieldPath: null,
    origin: isDeterministic ? 'deterministic' : 'model',
    // Exactly one of the two codes is set, and which one is set is what `origin` names. A
    // deterministic finding carries the check that produced it; a model finding carries the code
    // the model chose from the closed enum.
    checkCode: isDeterministic ? 'DISCONNECTED_NODE' : null,
    normalizedIssueCode: isDeterministic ? null : 'ambiguous_business_rule',
  };
}

function root(commentId: string, issueKey: string, status: PreviousRoot['status']): PreviousRoot {
  return { commentId, issueKey, status };
}

const DET = 'det:missing_owner:node:action:1';
const MOD = 'mod:ambiguous_threshold:canvas';

describe('reconcile', () => {
  it('inserts a finding nobody has seen before', () => {
    const result = reconcile([], [finding(DET)], []);
    expect(result.toInsert.map((f) => f.issueKey)).toEqual([DET]);
    expect(result.toRecur).toEqual([]);
  });

  it('records a recurrence rather than a duplicate when the issue is already open', () => {
    // A second root for the same issue would double the unresolved count and make the thread
    // impossible to follow. The recurrence appends to the existing thread instead.
    const result = reconcile([root('c1', DET, 'open')], [finding(DET)], []);
    expect(result.toInsert).toEqual([]);
    expect(result.toRecur.map((f) => f.issueKey)).toEqual([DET]);
  });

  it('treats an answered issue as still live', () => {
    // Replying to a finding is not resolving it. If it were, an operator could clear any board by
    // typing a sentence under each issue.
    const result = reconcile([root('c1', DET, 'answered')], [finding(DET)], []);
    expect(result.toRecur.map((f) => f.issueKey)).toEqual([DET]);
    expect(result.toResolve).toEqual([]);
  });

  it('never reopens a rejected finding, but does record that it recurred', () => {
    const result = reconcile([root('c1', DET, 'rejected')], [finding(DET)], []);
    expect(result.toInsert).toEqual([]);
    expect(result.toRecur).toEqual([]);
    expect(result.recurredRejected.map((r) => r.commentId)).toEqual(['c1']);
  });

  it('resolves a deterministic issue once its check stops firing', () => {
    const result = reconcile([root('c1', DET, 'open')], [], [], []);
    expect(result.toResolve.map((r) => r.commentId)).toEqual(['c1']);
  });

  it('refuses to resolve a deterministic issue whose check still fires', () => {
    // The model may not have mentioned it, but the check is not a matter of opinion.
    const result = reconcile([root('c1', DET, 'open')], [], [], [DET]);
    expect(result.toResolve).toEqual([]);
  });

  it('refuses to resolve a model finding that merely went unmentioned', () => {
    // This is the case the whole function exists for. Silence from a model is not evidence.
    const result = reconcile([root('c1', MOD, 'open')], [], []);
    expect(result.toResolve).toEqual([]);
  });

  it('resolves a model finding once the operator records an assumption for it', () => {
    const result = reconcile([root('c1', MOD, 'open')], [], ['c1']);
    expect(result.toResolve.map((r) => r.commentId)).toEqual(['c1']);
  });

  it('does not let an assumption on one thread resolve another', () => {
    const result = reconcile(
      [root('c1', MOD, 'open'), root('c2', 'mod:other:canvas', 'open')],
      [],
      ['c1'],
    );
    expect(result.toResolve.map((r) => r.commentId)).toEqual(['c1']);
  });

  it('leaves an already-resolved root alone', () => {
    const result = reconcile([root('c1', DET, 'resolved')], [], []);
    expect(result.toResolve).toEqual([]);
    expect(result.toRecur).toEqual([]);
  });

  it('handles a round that both resolves one issue and raises another', () => {
    const result = reconcile(
      [root('c1', DET, 'open')],
      [finding('det:unlabeled_branch:node:rule:2')],
      [],
      [],
    );
    expect(result.toResolve.map((r) => r.commentId)).toEqual(['c1']);
    expect(result.toInsert.map((f) => f.issueKey)).toEqual(['det:unlabeled_branch:node:rule:2']);
  });

  it('classifies every finding exactly once', () => {
    const findings = [finding(DET), finding(MOD), finding('det:new:canvas')];
    const result = reconcile([root('c1', DET, 'open'), root('c2', MOD, 'rejected')], findings, []);
    const classified =
      result.toInsert.length + result.toRecur.length + result.recurredRejected.length;
    expect(classified).toBe(findings.length);
  });
});
