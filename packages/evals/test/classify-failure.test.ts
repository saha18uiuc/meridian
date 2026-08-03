import { describe, expect, it } from 'vitest';
import type { AssertionFailure } from '../src/assertions.js';
import { classify, stopsRepairLoop } from '../src/classify-failure.js';

/**
 * Which kind of failure this is, and therefore who is allowed to fix it.
 *
 * The classification exists to stop the repair loop from inventing business policy, so the tests
 * are weighted towards the permissive mistake. Calling a policy gap an `implementation` failure
 * hands the repair skill a licence to write a rule nobody agreed to, and that rule would then ship
 * with a green suite behind it. Calling an implementation bug a `policy_gap` merely wastes a human's
 * time, which is why anything ambiguous lands there.
 */

function failure(assertion: string): AssertionFailure {
  return { assertion, expected: null, actual: null, message: assertion };
}

describe('failure classification', () => {
  it('treats transient tool errors as infrastructure, not as agent bugs', () => {
    for (const errorName of ['RetryableToolError', 'RateLimitError', 'ToolUnavailableError']) {
      expect(classify({ failures: [], errorName })).toBe('tool_infrastructure');
    }
  });

  it('treats extraction errors and failed extract steps as extraction failures', () => {
    expect(classify({ failures: [], errorName: 'ExtractionError' })).toBe('extraction');
    expect(classify({ failures: [], failedStepKey: 'extract' })).toBe('extraction');
  });

  it('classifies an expectation the spec does not state as a policy gap, whatever failed', () => {
    // This is the override that matters: even a failure that looks like an implementation bug is a
    // gap when the case's expectation traces to nothing in the frozen spec.
    expect(classify({ failures: [failure('outcome')], specTraceKnownGap: true })).toBe(
      'policy_gap',
    );
    expect(
      classify({
        failures: [failure('externalActions.noDuplicateSends')],
        specTraceKnownGap: true,
      }),
    ).toBe('policy_gap');
  });

  it('classifies duplicate sends and broken lineage as implementation bugs', () => {
    expect(classify({ failures: [failure('externalActions.noDuplicateSends')] })).toBe(
      'implementation',
    );
    expect(classify({ failures: [failure('stepLineage.unique')] })).toBe('implementation');
    expect(classify({ failures: [failure('gitLineage.sha')] })).toBe('implementation');
    expect(classify({ failures: [failure('retries.extract')] })).toBe('implementation');
  });

  it('classifies a disagreement about outcome as an implementation bug', () => {
    expect(classify({ failures: [failure('outcome')] })).toBe('implementation');
    expect(classify({ failures: [failure('missingFields')] })).toBe('implementation');
    expect(classify({ failures: [failure('businessKey')] })).toBe('implementation');
  });

  it('falls back to policy_gap when nothing recognizable failed', () => {
    expect(classify({ failures: [] })).toBe('policy_gap');
    expect(classify({ failures: [failure('somethingNobodyAnticipated')] })).toBe('policy_gap');
  });

  it('stops the repair loop for exactly the two classes a code change cannot fix', () => {
    expect(stopsRepairLoop('policy_gap')).toBe(true);
    expect(stopsRepairLoop('tool_infrastructure')).toBe(true);
    expect(stopsRepairLoop('implementation')).toBe(false);
    expect(stopsRepairLoop('extraction')).toBe(false);
  });
});
