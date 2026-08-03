import { isAgentError, NON_RETRYABLE_FAILURE_TYPES } from '@meridian/agent-kit';
import { ApplicationFailure } from '@temporalio/common';

/**
 * Converts a thrown error into a Temporal failure whose `type` the retry policy can match.
 *
 * A specific error class name is used when the policy lists it, so `db/action-state-machine`-style
 * failures stay legible in the Temporal UI; anything else collapses to the two branch names. An
 * unknown error is left retryable, because guessing that an unrecognised failure is permanent
 * would silently turn a transient outage into a failed run.
 */
export function toTemporalFailure(error: unknown): never {
  if (isAgentError(error)) {
    const listed = (NON_RETRYABLE_FAILURE_TYPES as readonly string[]).includes(error.name);
    throw ApplicationFailure.create({
      message: error.message,
      type: listed ? error.name : error.failureType,
      nonRetryable: error.nonRetryable,
      details: [error.toJSON()],
    });
  }
  throw error;
}

/** Wraps an activity body so every thrown `AgentError` carries its retry semantics across. */
export async function withFailureMapping<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    return toTemporalFailure(error);
  }
}
