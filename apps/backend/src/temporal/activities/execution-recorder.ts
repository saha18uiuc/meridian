import type { ExecutionStep } from '@meridian/core/schemas';
import { Context } from '@temporalio/activity';
import { withFailureMapping } from './failures.js';
import { recorderFor } from './runtime.js';

/**
 * Persistence activities.
 *
 * `attemptNo` always comes from `Context.current().info.attempt`, never from a counter the workflow
 * keeps. Temporal already knows which attempt this is, and deriving it anywhere else would drift
 * the moment an activity failed in a way the workflow did not observe.
 */

export interface StartStepArgs {
  executionId: string;
  nodeId: string | null;
  stepKey: string;
  stepInstanceKey: string;
  sequenceNo: number;
  inputSummary?: Record<string, unknown>;
}

export async function recorderStartStep(args: StartStepArgs): Promise<ExecutionStep> {
  return withFailureMapping(async () => {
    const attemptNo = currentAttempt();
    return recorderFor(args.executionId).startStep({
      nodeId: args.nodeId,
      stepKey: args.stepKey,
      stepInstanceKey: args.stepInstanceKey,
      sequenceNo: args.sequenceNo,
      attemptNo,
      inputSummary: args.inputSummary ?? {},
    });
  });
}

export async function recorderCompleteStep(args: {
  executionId: string;
  stepExecutionId: string;
  output: Record<string, unknown>;
}): Promise<ExecutionStep> {
  return withFailureMapping(async () =>
    recorderFor(args.executionId).completeStep(args.stepExecutionId, args.output),
  );
}

export async function recorderFailStep(args: {
  executionId: string;
  stepExecutionId: string;
  error: Record<string, unknown>;
}): Promise<ExecutionStep> {
  return withFailureMapping(async () =>
    recorderFor(args.executionId).failStep(args.stepExecutionId, args.error),
  );
}

export async function recorderAppendEvidence(args: {
  executionId: string;
  stepExecutionId: string | null;
  payload: Record<string, unknown>;
  eventKey?: string;
}): Promise<{ eventId: number }> {
  return withFailureMapping(async () =>
    recorderFor(args.executionId).appendEvidence(
      args.stepExecutionId,
      args.payload,
      args.eventKey === undefined ? {} : { eventKey: args.eventKey },
    ),
  );
}

/**
 * Outside an activity — the eval harness invokes some of these directly — Temporal has no attempt
 * to report, so the first attempt is the honest answer.
 */
function currentAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
}
