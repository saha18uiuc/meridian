import type { ExecutionStep } from '@meridian/core/schemas';
import { Context } from '@temporalio/activity';
import { withFailureMapping } from './failures.js';
import { recorderFor, serviceClient } from './runtime.js';

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
 * Close the execution row the intake path opened.
 *
 * The workflow closing the row itself, as its last durable act, is the only arrangement that keeps
 * the two in step: Temporal knows the run ended, but nothing watches Temporal on the application's
 * behalf, so an execution whose workflow completed without this call sits in `running` forever and
 * the UI shows a shipment still being processed that finished minutes ago.
 *
 * Both RPCs are idempotent on an already-terminal row, so a replayed activity is free.
 */
export async function executionComplete(args: {
  executionId: string;
  status: 'passed' | 'failed';
  outputSummary: Record<string, unknown>;
}): Promise<void> {
  return withFailureMapping(async () => {
    const { error } = await serviceClient().rpc('complete_execution', {
      p_execution_id: args.executionId,
      p_status: args.status,
      p_output_summary: args.outputSummary as never,
      p_diff_summary: null as never,
    });
    if (error !== null) throw new Error(`complete_execution failed: ${error.message}`);
  });
}

export async function executionFail(args: {
  executionId: string;
  error: Record<string, unknown>;
}): Promise<void> {
  return withFailureMapping(async () => {
    const { error } = await serviceClient().rpc('fail_execution', {
      p_execution_id: args.executionId,
      p_error: args.error as never,
    });
    if (error !== null) throw new Error(`fail_execution failed: ${error.message}`);
  });
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
