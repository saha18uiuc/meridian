/**
 * The typed error hierarchy shared by the runtime and generated agents.
 *
 * `AgentError` is the base; `RetryableToolError` and `NonRetryableToolError` are the two branches
 * Temporal actually cares about. The activity layer converts any `nonRetryable` error into
 * `ApplicationFailure` with the type name `NonRetryableToolError`, which is what the retry policy's
 * `nonRetryableErrorTypes` list matches on. Everything more specific is a subclass, so adding a new
 * precise error can never accidentally make a hopeless failure retryable.
 */
export abstract class AgentError extends Error {
  abstract readonly code: string;
  abstract readonly nonRetryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  /** The Temporal failure type this error maps to; only these two names appear in the policy. */
  get failureType(): 'RetryableToolError' | 'NonRetryableToolError' {
    return this.nonRetryable ? 'NonRetryableToolError' : 'RetryableToolError';
  }

  toJSON(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Transient: a second attempt has a genuine chance of succeeding. */
export class RetryableToolError extends AgentError {
  readonly code: string;
  readonly nonRetryable = false;
  constructor(tool: string, reason: string, details: Record<string, unknown> = {}) {
    super(`Tool '${tool}' failed transiently: ${reason}`, { tool, ...details });
    this.code = 'RETRYABLE_TOOL_ERROR';
  }
}

/** Permanent: retrying only burns the budget and delays the honest failure. */
export class NonRetryableToolError extends AgentError {
  readonly code: string;
  readonly nonRetryable = true;
  constructor(tool: string, reason: string, details: Record<string, unknown> = {}) {
    super(`Tool '${tool}' cannot proceed: ${reason}`, { tool, ...details });
    this.code = 'NON_RETRYABLE_TOOL_ERROR';
  }
}

export class CapabilityDeniedError extends AgentError {
  readonly code = 'CAPABILITY_DENIED';
  readonly nonRetryable = true;
  constructor(capability: string, granted: readonly string[]) {
    super(`Capability '${capability}' is not granted by the frozen spec.`, {
      capability,
      granted: [...granted],
    });
  }
}

export class ExtractionError extends AgentError {
  readonly code = 'EXTRACTION_FAILED';
  readonly nonRetryable = true;
  constructor(filename: string, reason: string) {
    super(`Could not extract text from ${filename}: ${reason}`, { filename, reason });
  }
}

/**
 * The business policy needed to decide this case does not exist in the frozen spec.
 *
 * This is deliberately non-retryable and deliberately distinct from a validation failure: the
 * repair loop is allowed to patch extraction and implementation bugs, but a policy gap must go
 * back to a human as a whiteboard comment rather than being invented by a model.
 */
export class PolicyGapError extends AgentError {
  readonly code = 'POLICY_GAP';
  readonly nonRetryable = true;
  constructor(question: string, details: Record<string, unknown> = {}) {
    super(`The frozen specification does not answer: ${question}`, { question, ...details });
  }
}

export class ValidationError extends AgentError {
  readonly code = 'VALIDATION_FAILED';
  readonly nonRetryable = true;
  constructor(what: string, issues: unknown) {
    super(`${what} failed schema validation.`, { issues });
  }
}

/**
 * The reservation is in `needs_reconciliation`, so the send may already have escaped. Retrying is
 * forbidden without positive proof of non-delivery, which is why this is non-retryable and routes
 * the workflow to manual review instead.
 */
export class ActionNeedsReconciliationError extends AgentError {
  readonly code = 'ACTION_NEEDS_RECONCILIATION';
  readonly nonRetryable = true;
  constructor(executionActionId: string, markerToken: string) {
    super(
      'The external action may already have been delivered; it cannot be retried without proof of non-delivery.',
      { executionActionId, markerToken },
    );
  }
}

export class AgentNotRegisteredError extends AgentError {
  readonly code = 'AGENT_NOT_REGISTERED';
  readonly nonRetryable = true;
  constructor(deploymentKey: string, versionNo: number) {
    super(
      `No agent registered for deployment key '${deploymentKey}' version ${versionNo}. Regenerate generated-agents/index.ts and restart the worker.`,
      { deploymentKey, versionNo },
    );
  }
}

/** A generated folder no longer matches the spec its version was frozen from. */
export class SpecHashMismatchError extends NonRetryableToolError {
  constructor(expected: string, actual: string) {
    super('registry', 'the resolved agent was generated from a different frozen spec', {
      expected,
      actual,
    });
  }
}

export class ToolUnavailableError extends NonRetryableToolError {}

export class ExternalActionError extends RetryableToolError {
  constructor(actionType: string, reason: string, details: Record<string, unknown> = {}) {
    super(actionType, reason, details);
  }
}

export class HumanDecisionTimeoutError extends AgentError {
  readonly code = 'HUMAN_DECISION_TIMEOUT';
  readonly nonRetryable = true;
  constructor(requestId: string, timeout: string) {
    super(`No human decision for '${requestId}' within ${timeout}.`, { requestId, timeout });
  }
}

export class DomainNotAllowedError extends NonRetryableToolError {
  constructor(url: string, allowed: readonly string[]) {
    super('browser', `'${url}' is outside the configured allow-list`, {
      url,
      allowed: [...allowed],
    });
  }
}

/** Exactly the names the activity retry policy refuses to retry (§8 decision 23). */
export const NON_RETRYABLE_FAILURE_TYPES = [
  'NonRetryableToolError',
  'CapabilityDeniedError',
  'PolicyGapError',
  'ValidationError',
  'ActionNeedsReconciliationError',
] as const;

export const AGENT_ERROR_CODES = [
  'RETRYABLE_TOOL_ERROR',
  'NON_RETRYABLE_TOOL_ERROR',
  'CAPABILITY_DENIED',
  'EXTRACTION_FAILED',
  'POLICY_GAP',
  'VALIDATION_FAILED',
  'ACTION_NEEDS_RECONCILIATION',
  'AGENT_NOT_REGISTERED',
  'HUMAN_DECISION_TIMEOUT',
] as const;

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}
