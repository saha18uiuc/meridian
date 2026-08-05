import {
  NEW_MESSAGE_SIGNAL,
  RECEIVING_WORKFLOW_TYPE,
  taskQueueName,
  type ReceivingWorkflowInput,
} from '@meridian/core/temporal-contract';
import type { Client } from '@temporalio/client';

/**
 * The single atomic Temporal call in the intake path (§5.11 step 6, A24).
 *
 * `signalWithStart` is "start if absent, otherwise signal", performed on the Temporal server. The
 * alternative — try to start, catch `WorkflowExecutionAlreadyStartedError`, then signal — has a
 * real race window between the two calls, and turning an error into control flow hides genuine
 * failures. Here that error is never expected, so if it ever surfaces it is a bug worth seeing.
 *
 * The workflow type is named by string rather than by importing the workflow function, which keeps
 * the activity graph (and the provider SDKs it reaches) out of whatever process runs intake.
 */

export interface SignalWithStartOptions {
  client: Client;
  workflowId: string;
  /** The pinned workflow argument: agent identity, spec hash, Git SHA, execution ID, messages. */
  input: ReceivingWorkflowInput;
  /** The first message, delivered as a signal as well; the workflow deduplicates it. */
  signalArg: Record<string, unknown>;
  taskQueue?: string;
  /**
   * The run ID already recorded on the `executions` row, when there is one.
   *
   * Temporal returns the same field whether it started a run or signalled one, so the API alone
   * cannot say which happened. Comparing against what was recorded before the call can, and the
   * database is the thing that actually needs to know.
   */
  knownRunId?: string | null;
}

export interface SignalWithStartResult {
  workflowId: string;
  runId: string;
  /** True when the server routed this call to the run already recorded for this execution. */
  wasAlreadyRunning: boolean;
}

export function buildSignalWithStartOptions(options: SignalWithStartOptions): {
  workflowId: string;
  taskQueue: string;
  args: unknown[];
  signal: string;
  signalArgs: unknown[];
  workflowIdReusePolicy: 'ALLOW_DUPLICATE';
  workflowIdConflictPolicy: 'USE_EXISTING';
} {
  return {
    workflowId: options.workflowId,
    taskQueue: options.taskQueue ?? taskQueueName(),
    args: [options.input],
    signal: NEW_MESSAGE_SIGNAL,
    signalArgs: [options.signalArg],
    // ALLOW_DUPLICATE lets a completed workflow ID start a fresh run, which is what the
    // "late follow-up after a terminal execution" case needs.
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    // USE_EXISTING is what makes this call a signal rather than an error when a run is live.
    workflowIdConflictPolicy: 'USE_EXISTING',
  };
}

export async function signalWithStartReceiving(
  options: SignalWithStartOptions,
): Promise<SignalWithStartResult> {
  const built = buildSignalWithStartOptions(options);
  const handle = await options.client.workflow.signalWithStart(RECEIVING_WORKFLOW_TYPE, built);
  // `signaledRunId` is the run the server actually delivered to, which is not necessarily the
  // chain's first run when a completed workflow ID was reused.
  const runId = handle.signaledRunId;
  return {
    workflowId: handle.workflowId,
    runId,
    wasAlreadyRunning:
      options.knownRunId !== undefined &&
      options.knownRunId !== null &&
      options.knownRunId === runId,
  };
}
