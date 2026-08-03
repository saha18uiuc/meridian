import type { FailureClass } from '@meridian/core/schemas';
import type { AssertionFailure } from './assertions.js';

/**
 * Which kind of failure this is, and therefore who is allowed to fix it.
 *
 * The classification exists to stop the repair loop from inventing business policy. Only
 * `extraction` and `implementation` are repairable by editing a new agent version;
 * `tool_infrastructure` is an environment problem and `policy_gap` is a question for the person who
 * owns the process. Getting this wrong in the permissive direction is the worst outcome the whole
 * design is trying to prevent, so anything ambiguous classifies as `policy_gap` and stops.
 */

export interface CaseFailureContext {
  failures: readonly AssertionFailure[];
  /** The error class name thrown by the run, if it threw. */
  errorName?: string | null;
  /** `step_key` of the step that failed, when a step failed. */
  failedStepKey?: string | null;
  /** Whether the case's expectation traces to a statement in the frozen spec. */
  specTraceKnownGap?: boolean;
}

const TOOL_ERRORS = new Set([
  'ToolUnavailableError',
  'RetryableToolError',
  'RateLimitError',
  'TransientNetworkError',
]);

const EXTRACTION_ERRORS = new Set(['ExtractionError', 'ValidationError']);

/** Assertions that can only fail because the code does not implement a rule the spec states. */
const IMPLEMENTATION_ASSERTIONS = new Set([
  'externalActions.noDuplicateSends',
  'stepLineage.unique',
  'gitLineage.sha',
  'gitLineage.specHash',
  'retries',
]);

export function classify(context: CaseFailureContext): FailureClass {
  const errorName = context.errorName ?? null;
  if (errorName !== null && TOOL_ERRORS.has(errorName)) return 'tool_infrastructure';
  if (errorName !== null && EXTRACTION_ERRORS.has(errorName)) return 'extraction';

  // A case whose expectation the spec does not state is a gap by construction, whatever the
  // assertion happened to say.
  if (context.specTraceKnownGap === true) return 'policy_gap';

  if (context.failedStepKey === 'extract') return 'extraction';

  // Assertion names are dotted paths whose depth varies: `retries.extract` names a step,
  // `externalActions.mail.send.count` names an action type, and `stepLineage.unique` names
  // nothing further. Matching every prefix rather than a fixed depth is what keeps the set above
  // readable without letting a deeper name fall through to `policy_gap` by accident.
  const names = context.failures.map((failure) => failure.assertion);
  const matchesImplementation = (name: string): boolean => {
    const segments = name.split('.');
    return segments.some((_segment, index) =>
      IMPLEMENTATION_ASSERTIONS.has(segments.slice(0, index + 1).join('.')),
    );
  };
  if (names.some(matchesImplementation)) return 'implementation';

  // A mismatched outcome, missing-field list, or business key means the code and the spec disagree
  // about what should happen. That is repairable only if the spec actually says which is right; the
  // caller decides that by inspecting `specTrace`, and until it does, the safe answer is to stop.
  if (
    names.includes('outcome') ||
    names.includes('missingFields') ||
    names.includes('businessKey')
  ) {
    return 'implementation';
  }

  return 'policy_gap';
}

/** True when the loop must stop instead of reserving a repair version. */
export function stopsRepairLoop(failureClass: FailureClass): boolean {
  return failureClass === 'policy_gap' || failureClass === 'tool_infrastructure';
}

/**
 * How many repair versions may be reserved for one red suite before the loop hands back to a human.
 *
 * Three is not a tuning parameter. A loop that keeps going has no way to tell "nearly there" from
 * "editing at random", and the second one produces a directory of near-identical versions and a
 * commit history that says nothing.
 */
export const MAX_REPAIR_ITERATIONS = 3;

export type RepairAction =
  | { kind: 'done' }
  | { kind: 'repair'; caseKey: string; failureClass: FailureClass }
  | { kind: 'record_policy_gap'; caseKey: string; failureKey: string }
  | { kind: 'stop'; reason: string };

/**
 * What the repair loop should do next, given a suite result.
 *
 * This is separated from the runner because it is the one decision in the loop that must never be
 * made implicitly. Three of the four answers stop: a green suite, a gap that belongs to the person
 * who owns the process, and an environment failure that no code change can fix. Only the fourth
 * reserves another version.
 */
export function nextRepairAction(input: {
  green: boolean;
  failure: { caseKey: string; failureClass: FailureClass | null } | null;
  iterationsUsed: number;
}): RepairAction {
  if (input.green) return { kind: 'done' };
  if (input.failure === null) {
    return { kind: 'stop', reason: 'the suite is not green but reported no failing case' };
  }

  const failureClass = input.failure.failureClass ?? 'policy_gap';
  if (failureClass === 'policy_gap') {
    return {
      kind: 'record_policy_gap',
      caseKey: input.failure.caseKey,
      failureKey: `${input.failure.caseKey}_policy_gap`,
    };
  }
  if (failureClass === 'tool_infrastructure') {
    return {
      kind: 'stop',
      reason: `${input.failure.caseKey} failed on tooling or infrastructure, which a code change cannot fix`,
    };
  }
  if (input.iterationsUsed >= MAX_REPAIR_ITERATIONS) {
    return {
      kind: 'stop',
      reason: `${String(MAX_REPAIR_ITERATIONS)} repair attempts did not turn the suite green`,
    };
  }
  return { kind: 'repair', caseKey: input.failure.caseKey, failureClass };
}
