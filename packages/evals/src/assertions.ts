import type {
  AgentDecision,
  EvalCase,
  ExecutionAction,
  ExecutionStep,
} from '@meridian/core/schemas';

/**
 * What a passing eval case actually means.
 *
 * Each assertion is a pure function of the recorded run, never of the harness's own intentions, so
 * a case cannot pass because the harness knew what it wanted. Every check returns a named failure
 * rather than throwing, because a run that breaks three expectations is more useful to a repair
 * than a run that reports the first one and stops.
 */

export interface AssertionFailure {
  assertion: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface RunObservation {
  decision: AgentDecision | null;
  steps: readonly ExecutionStep[];
  actions: readonly ExecutionAction[];
  evidenceKeys: readonly string[];
  /** `agent_versions.git_commit_sha` for the version that ran, read back from the database. */
  gitCommitSha: string | null;
  manifestSpecHash: string | null;
  executionSpecHash: string | null;
  humanDecisionRequested: boolean;
  /** Storage paths recorded on evidence rows, used to prove artifacts were persisted. */
  storagePaths: readonly string[];
}

function fail(
  assertion: string,
  expected: unknown,
  actual: unknown,
  message: string,
): AssertionFailure {
  return { assertion, expected, actual, message };
}

export function assertOutcome(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const actual = run.decision?.outcome ?? null;
  return actual === evalCase.expected.outcome
    ? []
    : [
        fail(
          'outcome',
          evalCase.expected.outcome,
          actual,
          `expected outcome ${evalCase.expected.outcome}`,
        ),
      ];
}

export function assertBusinessKey(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  if (evalCase.expected.businessKey === undefined) return [];
  const actual = run.decision?.businessKey ?? null;
  return actual === evalCase.expected.businessKey
    ? []
    : [fail('businessKey', evalCase.expected.businessKey, actual, 'business key mismatch')];
}

export function assertMissingFields(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const expected = evalCase.expected.missingFields;
  if (expected === undefined) return [];
  const actual = [...(run.decision?.missingInformation ?? [])].sort();
  const wanted = [...expected].sort();
  const same =
    wanted.length === actual.length && wanted.every((value, index) => value === actual[index]);
  return same ? [] : [fail('missingFields', wanted, actual, 'missing-information list differs')];
}

/**
 * External actions, including the property that matters most: no duplicate sends.
 *
 * Counting rows with a terminal `succeeded` status is not enough on its own — a crash-and-retry bug
 * shows up as two rows sharing one idempotency key — so the key uniqueness is asserted separately.
 */
export function assertExternalActions(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const expectations = evalCase.expected.externalActions ?? [];

  for (const expectation of expectations) {
    const matching = run.actions.filter((action) => action.actionType === expectation.actionType);
    if (matching.length !== expectation.count) {
      failures.push(
        fail(
          `externalActions.${expectation.actionType}.count`,
          expectation.count,
          matching.length,
          `expected ${String(expectation.count)} ${expectation.actionType} action(s)`,
        ),
      );
      continue;
    }
    const wrong = matching.filter((action) => action.status !== expectation.finalStatus);
    if (wrong.length > 0) {
      failures.push(
        fail(
          `externalActions.${expectation.actionType}.status`,
          expectation.finalStatus,
          wrong.map((action) => action.status),
          `every ${expectation.actionType} action must end ${expectation.finalStatus}`,
        ),
      );
    }
  }

  if (expectations.length === 0 && run.actions.length > 0) {
    failures.push(
      fail(
        'externalActions.none',
        [],
        run.actions.map((action) => action.actionType),
        'the case expects no external action but the run performed one',
      ),
    );
  }

  const keys = run.actions.map((action) => action.idempotencyKey);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) {
    failures.push(
      fail(
        'externalActions.noDuplicateSends',
        [],
        [...new Set(duplicates)],
        'an action was reserved twice under one key',
      ),
    );
  }

  return failures;
}

/**
 * Step lineage. `step_instance_key` is the logical identity; `sequence_no` is display ordering and
 * is deliberately not asserted, because parallel siblings legitimately share an ordinal.
 */
export function assertStepLineage(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const expected = evalCase.expected.stepInstanceKeys ?? [];
  const present = new Set(run.steps.map((step) => step.stepInstanceKey));

  const absent = expected.filter((key) => !present.has(key));
  if (absent.length > 0) {
    failures.push(
      fail(
        'stepInstanceKeys',
        expected,
        [...present].sort(),
        `missing step instances: ${absent.join(', ')}`,
      ),
    );
  }

  const seen = new Set<string>();
  const collisions: string[] = [];
  for (const step of run.steps) {
    const identity = `${step.stepInstanceKey}#${String(step.attemptNo)}`;
    if (seen.has(identity)) collisions.push(identity);
    seen.add(identity);
  }
  if (collisions.length > 0) {
    failures.push(
      fail('stepLineage.unique', [], collisions, 'a step instance recorded the same attempt twice'),
    );
  }

  return failures;
}

export function assertEvidence(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const expected = evalCase.expected.evidenceKeys ?? [];
  const absent = expected.filter((key) => !run.evidenceKeys.includes(key));
  return absent.length === 0
    ? []
    : [
        fail(
          'evidenceKeys',
          expected,
          [...run.evidenceKeys].sort(),
          `missing evidence: ${absent.join(', ')}`,
        ),
      ];
}

export function assertRetries(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const expected = evalCase.expected.retries;
  if (expected === undefined) return [];

  const failures: AssertionFailure[] = [];
  for (const [stepKey, count] of Object.entries(expected)) {
    const attempts = run.steps.filter((step) => step.stepKey === stepKey);
    const retries =
      attempts.length === 0 ? 0 : Math.max(...attempts.map((step) => step.attemptNo)) - 1;
    if (retries !== count) {
      failures.push(
        fail(
          `retries.${stepKey}`,
          count,
          retries,
          `expected ${String(count)} retry(ies) of ${stepKey}`,
        ),
      );
    }
  }
  return failures;
}

export function assertHumanDecision(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  if (evalCase.expected.humanDecisionRequired === undefined) return [];
  return run.humanDecisionRequested === evalCase.expected.humanDecisionRequired
    ? []
    : [
        fail(
          'humanDecisionRequired',
          evalCase.expected.humanDecisionRequired,
          run.humanDecisionRequested,
          'human-decision expectation mismatch',
        ),
      ];
}

/**
 * Git lineage, asserted on every case rather than only where a case opts in. A run whose agent
 * version has no recorded commit cannot be reproduced, so a green suite over such a version would
 * be measuring code nobody can point at.
 */
export function assertGitLineage(_evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  if (run.gitCommitSha === null || run.gitCommitSha.length !== 40) {
    failures.push(
      fail(
        'gitLineage.sha',
        '40-character sha',
        run.gitCommitSha,
        'the agent version records no Git commit',
      ),
    );
  }
  if (run.manifestSpecHash !== run.executionSpecHash) {
    failures.push(
      fail(
        'gitLineage.specHash',
        run.executionSpecHash,
        run.manifestSpecHash,
        'the build manifest and the pinned execution disagree about the spec hash',
      ),
    );
  }
  return failures;
}

export const ASSERTIONS = [
  assertOutcome,
  assertBusinessKey,
  assertMissingFields,
  assertExternalActions,
  assertStepLineage,
  assertEvidence,
  assertRetries,
  assertHumanDecision,
  assertGitLineage,
] as const;

export function runAssertions(evalCase: EvalCase, run: RunObservation): AssertionFailure[] {
  return ASSERTIONS.flatMap((assertion) => assertion(evalCase, run));
}
