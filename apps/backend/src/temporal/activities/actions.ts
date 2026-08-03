import { sendWithReservation, type ActionOutcome, type SendActionType } from '@meridian/agent-kit';
import { withFailureMapping } from './failures.js';
import { type ActivityEnvelope, recorderFor, toolsFor } from './runtime.js';

/**
 * The external-action protocol (§5.9), as one activity.
 *
 * The protocol itself lives in `@meridian/agent-kit`, where the eval harness can reach it too; what
 * belongs here is the decision to run the whole thing inside a *single* activity. Splitting reserve,
 * dispatch, and complete across three activities would put a Temporal retry boundary in the middle
 * of the very window the protocol exists to close.
 */

export { MAX_DISPATCH_ATTEMPTS } from '@meridian/agent-kit';
export type { ActionOutcome } from '@meridian/agent-kit';

export interface SendMailActionArgs {
  envelope: ActivityEnvelope;
  stepExecutionId: string;
  actionType: SendActionType;
  payload: { to: string; subject: string; body: string; threadId?: string };
  /** Resolved Composio toolkit version, recorded with the action so a replay names it (A29). */
  toolkitVersion: string;
}

export async function performMailAction(args: SendMailActionArgs): Promise<ActionOutcome> {
  return withFailureMapping(async () =>
    sendWithReservation({
      recorder: recorderFor(args.envelope.executionId),
      mailbox: toolsFor(args.envelope).mailbox,
      stepExecutionId: args.stepExecutionId,
      actionType: args.actionType,
      payload: args.payload,
      toolkitVersion: args.toolkitVersion,
    }),
  );
}

/** Records a human handoff request as evidence; the wait itself happens in the workflow. */
export async function recordHumanDecisionRequest(args: {
  executionId: string;
  stepExecutionId: string | null;
  requestId: string;
  question: string;
  evidence: Record<string, unknown>;
}): Promise<{ requestId: string }> {
  return withFailureMapping(async () => {
    await recorderFor(args.executionId).appendEvidence(
      args.stepExecutionId,
      {
        phase: 'human_handoff_requested',
        requestId: args.requestId,
        question: args.question,
        evidence: args.evidence,
      },
      { eventKey: `handoff:requested:${args.requestId}` },
    );
    return { requestId: args.requestId };
  });
}
