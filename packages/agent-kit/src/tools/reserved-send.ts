import type { ActionType, ExecutionAction, ReconciliationEvidence } from '@meridian/core/schemas';
import type { ExecutionRecorder, MailboxTool, OutboundMail } from '../contracts.js';
import {
  ActionNeedsReconciliationError,
  ExternalActionError,
  NonRetryableToolError,
} from '../errors.js';
import { RECONCILIATION_MAX_RESULTS, reconciliationQuery } from './mailbox.js';

/**
 * The external-action protocol (§5.9), in the one place both runtimes can reach it.
 *
 * It used to live in the Temporal activity, which meant the eval harness had no way to send through
 * it and the generated agent had to drive `reserve → dispatch → complete` by hand. That was the
 * wrong seam twice over: it put crash-recovery reasoning inside customer-specific generated code,
 * and it let the two runtimes disagree about what "send once" means. Here the agent calls
 * `mailbox.sendMessage` and nothing else; the worker reaches this through an activity and the eval
 * harness through a wrapper, and both get the same states in `execution_actions`.
 *
 * What this buys is **replay deduplication and best-effort external exactly-once behaviour**, not an
 * absolute exactly-once guarantee. Gmail's send endpoint accepts no client-supplied idempotency
 * token, so after a crash between dispatch and completion the only evidence available is a marker
 * token embedded in the body and a bounded search of the sent folder. When that search cannot
 * conclude, the action ends in `needs_reconciliation` or `abandoned` and a human is asked — it is
 * never blindly resent, because a duplicate customs email is worse than a late one.
 *
 * Every state change is a named RPC. Nothing here performs status arithmetic of its own.
 */

export type SendActionType = Extract<ActionType, 'mail.send' | 'mail.reply' | 'mail.draft'>;

export interface ActionOutcome {
  executionActionId: string;
  status: ExecutionAction['status'];
  providerActionId: string | null;
  markerToken: string;
  attemptCount: number;
}

export interface ReservedSendArgs {
  recorder: ExecutionRecorder;
  mailbox: MailboxTool;
  stepExecutionId: string;
  actionType: SendActionType;
  payload: { to: string; subject: string; body: string; threadId?: string };
  /** Resolved Composio toolkit version, recorded with the action so a replay names it (A29). */
  toolkitVersion: string;
}

/** After this many dispatches without a definite answer, the action is abandoned, not retried. */
export const MAX_DISPATCH_ATTEMPTS = 2;

export async function sendWithReservation(args: ReservedSendArgs): Promise<ActionOutcome> {
  const { recorder, mailbox } = args;

  // The recorded payload is what the idempotency key is derived from, so the toolkit version is
  // part of it: a run against a different provider surface is a different action.
  const requestPayload = { ...args.payload, toolkitVersion: args.toolkitVersion };

  let action = await recorder.reserveAction(args.stepExecutionId, args.actionType, requestPayload);

  switch (action.status) {
    case 'succeeded':
      return summarize(action);
    case 'failed':
      throw new NonRetryableToolError('mailbox', 'the reserved action already failed', {
        executionActionId: action.executionActionId,
      });
    case 'abandoned':
      throw new NonRetryableToolError('mailbox', 'the reserved action was abandoned', {
        executionActionId: action.executionActionId,
      });
    case 'needs_reconciliation':
      throw new ActionNeedsReconciliationError(action.executionActionId, action.markerToken);
    case 'dispatched':
      // A previous attempt died between dispatch and completion. Reconcile before anything else.
      action = await reconcile(action, args);
      if (action.status === 'succeeded') return summarize(action);
      if (action.status !== 'reserved') {
        throw new ActionNeedsReconciliationError(action.executionActionId, action.markerToken);
      }
      break;
    case 'reserved':
      break;
  }

  if (action.attemptCount >= MAX_DISPATCH_ATTEMPTS) {
    const abandoned = await recorder.abandonAction(action.executionActionId, {
      code: 'DISPATCH_BUDGET_EXHAUSTED',
      attemptCount: action.attemptCount,
    });
    throw new ActionNeedsReconciliationError(abandoned.executionActionId, abandoned.markerToken);
  }

  // Dispatch is recorded BEFORE the provider call, so a crash during the call is observable.
  action = await recorder.dispatchAction(action.executionActionId);

  try {
    const sent = await mailbox.sendMessage({
      to: args.payload.to,
      subject: args.payload.subject,
      body: args.payload.body,
      ...(args.payload.threadId === undefined ? {} : { threadId: args.payload.threadId }),
      markerToken: action.markerToken,
    });
    const completed = await recorder.completeAction(action.executionActionId, {
      status: 'succeeded',
      providerActionId: sent.providerMessageId,
      response: { threadId: sent.threadId },
    });
    return summarize(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDefiniteRejection(error)) {
      // The provider refused the request outright, so nothing was delivered and `failed` is the
      // honest terminal state.
      const failed = await recorder.completeAction(action.executionActionId, {
        status: 'failed',
        providerActionId: null,
        response: { error: message },
      });
      return summarize(failed);
    }
    const marked = await recorder.markActionForReconciliation(action.executionActionId, {
      code: 'INDETERMINATE_PROVIDER_RESULT',
      error: message,
    });
    const reconciled = await reconcile(marked, args);
    if (reconciled.status === 'succeeded') return summarize(reconciled);
    throw new ActionNeedsReconciliationError(reconciled.executionActionId, reconciled.markerToken);
  }
}

/**
 * Searches the sent folder for the marker token and feeds the answer to the reconciliation RPC.
 *
 * Three outcomes are permitted and no others. A match proves delivery. A search that succeeded and
 * returned nothing proves non-delivery, and only that proof may return the action to `reserved`.
 * Anything else — an error, an ambiguous result, an unreachable mailbox — is not proof, so the
 * action is abandoned rather than retried.
 */
async function reconcile(
  action: ExecutionAction,
  args: ReservedSendArgs,
): Promise<ExecutionAction> {
  const { recorder, mailbox } = args;
  const query = reconciliationQuery(action.markerToken);

  let matches: { messageId: string }[];
  try {
    matches = await mailbox.searchMessages(query, RECONCILIATION_MAX_RESULTS);
  } catch (error) {
    return recorder.abandonAction(action.executionActionId, {
      code: 'RECONCILIATION_QUERY_FAILED',
      method: 'gmail.search',
      query,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (matches.length === 1) {
    const evidence: ReconciliationEvidence = {
      provenNotDelivered: false,
      method: 'gmail.search',
      query,
      matchedProviderActionId: matches[0]?.messageId ?? null,
      inspectedCount: matches.length,
    };
    return recorder.reconcileAction(
      action.executionActionId,
      'succeeded',
      matches[0]?.messageId ?? null,
      evidence,
    );
  }

  if (matches.length === 0) {
    const evidence: ReconciliationEvidence = {
      provenNotDelivered: true,
      method: 'gmail.search',
      query,
      matchedProviderActionId: null,
      inspectedCount: 0,
      note: 'The mailbox was reachable and the marker token is absent from the sent folder.',
    };
    return recorder.reconcileAction(action.executionActionId, 'reserved', null, evidence);
  }

  // More than one match means the marker is ambiguous; picking one would be a guess.
  return recorder.abandonAction(action.executionActionId, {
    code: 'RECONCILIATION_AMBIGUOUS',
    method: 'gmail.search',
    query,
    inspectedCount: matches.length,
  });
}

function isDefiniteRejection(error: unknown): boolean {
  // Only the guard errors raised before any network traffic are definite. A provider error after
  // the request left the process could still have been delivered.
  return error instanceof NonRetryableToolError && !(error instanceof ExternalActionError);
}

function summarize(action: ExecutionAction): ActionOutcome {
  return {
    executionActionId: action.executionActionId,
    status: action.status,
    providerActionId: action.providerActionId,
    markerToken: action.markerToken,
    attemptCount: action.attemptCount,
  };
}

/**
 * A mailbox whose `sendMessage` goes through the reservation protocol.
 *
 * Used by any runner that hands the agent a raw adapter — the eval harness and the direct runner.
 * The worker does not use it: inside a workflow the protocol must run as a single activity, so the
 * proxy calls `performMailAction` instead. Both routes end at `sendWithReservation`.
 */
export function createReservingMailbox(options: {
  mailbox: MailboxTool;
  recorder: ExecutionRecorder;
  toolkitVersion: string;
  /** The step the action is attributed to, read at call time because it changes as the run walks. */
  currentStepExecutionId: () => string | null;
}): MailboxTool {
  return {
    ...options.mailbox,
    async sendMessage(payload: OutboundMail) {
      const outcome = await sendWithReservation({
        recorder: options.recorder,
        mailbox: options.mailbox,
        stepExecutionId: options.currentStepExecutionId() ?? '',
        actionType: payload.threadId === undefined ? 'mail.send' : 'mail.reply',
        payload: {
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
          ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
        },
        toolkitVersion: options.toolkitVersion,
      });
      return {
        providerMessageId: outcome.providerActionId ?? '',
        threadId: payload.threadId ?? '',
      };
    },
  };
}
