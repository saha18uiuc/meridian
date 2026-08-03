import {
  type AgentError,
  type AgentLogger,
  type Clock,
  type ExecutionRecorder,
  HumanDecisionTimeoutError,
  type IdempotencyHelper,
  isAgentError,
  NON_RETRYABLE_FAILURE_TYPES,
  NonRetryableToolError,
  type ToolRegistry,
} from '@meridian/agent-kit/contracts';
import * as workflow from '@temporalio/workflow';
import type { Activities } from '../activities/index.js';
import type { HumanDecisionPayload } from '../signals.js';

/**
 * Everything a workflow may touch, expressed as activity proxies.
 *
 * The registry handed to `AgentDefinition.run()` inside the sandbox contains only these wrappers.
 * The real Composio, Playwright, OpenAI, and Supabase code lives in `../activities/*` and never
 * enters the workflow bundle, which is what keeps `run()` deterministic and replayable.
 */

const RETRY_POLICY = {
  initialInterval: '1 second',
  backoffCoefficient: 2,
  maximumInterval: '30 seconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [...NON_RETRYABLE_FAILURE_TYPES],
};

const acts = workflow.proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: RETRY_POLICY,
});

export { acts as activities, RETRY_POLICY };

/**
 * Turn an agent error raised inside the sandbox into a failure that ends the execution.
 *
 * Temporal treats any error thrown from workflow code that is not an `ApplicationFailure` as a
 * *workflow task* failure, which it retries forever. That is the right default for a genuine bug —
 * a crashed worker should not lose the run — but it is exactly wrong for a `PolicyGapError` or a
 * denied capability, where the answer will never change and the execution would simply hang.
 *
 * The conversion happens here rather than in each agent because an agent should not have to know
 * what an `ApplicationFailure` is; the boundary between agent code and the orchestrator is the
 * right place to translate.
 */
export function asWorkflowFailure(error: unknown): unknown {
  if (!isAgentError(error)) return error;
  const agentError: AgentError = error;
  return workflow.ApplicationFailure.create({
    message: agentError.message,
    type: agentError.failureType,
    nonRetryable: agentError.nonRetryable,
    details: [{ code: agentError.code, ...agentError.details }],
  });
}

export interface WorkflowToolOptions {
  executionId: string;
  capabilities: string[];
  toolkitVersion: string;
  /** Signal-populated decision state, owned by the workflow. */
  decisions: Map<string, HumanDecisionPayload>;
  currentStepInstanceKey(): string;
  currentStepExecutionId(): string | null;
}

export function createWorkflowToolRegistry(options: WorkflowToolOptions): ToolRegistry {
  const envelope = { executionId: options.executionId, capabilities: options.capabilities };

  return {
    mailbox: {
      searchMessages: (query, maxResults) => acts.mailSearchMessages(envelope, query, maxResults),
      fetchThread: (threadId) => acts.mailFetchThread(envelope, threadId),
      downloadAttachments: (threadId) => acts.mailDownloadAttachments(envelope, threadId),
      createDraft: (payload) => acts.mailCreateDraft(envelope, payload),
      sendDraft: async () => {
        // A bare send would be retried by Temporal and could deliver twice; the reserve/dispatch
        // protocol is the only supported route out of the process.
        throw new NonRetryableToolError(
          'mailbox',
          'use performMailAction so the send is reserved, dispatched, and reconciled',
        );
      },
      sendMessage: async (payload) => {
        const outcome = await acts.performMailAction({
          envelope,
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
    },

    documents: {
      extractText: (fileRef) => acts.documentExtractText(envelope, fileRef),
      extractFields: (fileRef, schemaName) =>
        acts.documentExtractFields(envelope, fileRef, schemaName),
      normalizeValue: (value, type) => acts.documentNormalizeValue(envelope, value, type),
    },

    browser: {
      open: (url) => acts.browserOpen(envelope, url),
      extractText: (selector) => acts.browserExtractText(envelope, selector),
      download: (url) => acts.browserDownload(envelope, url),
      screenshot: () => acts.browserScreenshot(envelope),
    },

    humanHandoff: {
      async requestDecision(question, evidence) {
        const requestId = `handoff:${options.currentStepInstanceKey()}:${String(options.decisions.size + 1)}`;
        await acts.recordHumanDecisionRequest({
          executionId: options.executionId,
          stepExecutionId: options.currentStepExecutionId(),
          requestId,
          question,
          evidence,
        });
        return requestId;
      },
      async waitForDecision(requestId) {
        // Not an activity: a 24-hour activity would hold a worker slot and would not survive a
        // restart cleanly. A condition over signal state costs nothing while it waits.
        const arrived = await workflow.condition(
          () => options.decisions.has(requestId),
          '24 hours',
        );
        if (!arrived) throw new HumanDecisionTimeoutError(requestId, '24 hours');
        const decision = options.decisions.get(requestId);
        if (decision === undefined) throw new HumanDecisionTimeoutError(requestId, '24 hours');
        return { decision: decision.decision, notes: decision.notes };
      },
    },
  };
}

/**
 * The only clock workflow code reads.
 *
 * The sandbox replaces the global `Date` with one driven by workflow time, so `Date.now()` here
 * replays to the same value on every attempt. The Temporal TypeScript SDK exposes no separate
 * `now()` — the patched global *is* the API — which is why this single call site is exempted rather
 * than rewritten. Agents receive the reading through `context.clock` and never touch `Date`
 * themselves, which is what lets the rule ban it outright everywhere else in workflow code.
 */
// eslint-disable-next-line no-restricted-globals, no-restricted-properties -- workflow time
export const workflowClock: Clock = { now: () => Date.now() };

/**
 * Key derivation needs SHA-256, which the workflow sandbox does not provide, and it is not needed
 * there anyway: the recorder derives the key inside the activity from the same four inputs, so a
 * replay reaches the identical reservation. Only the marker token — a pure string slice — is
 * available in the sandbox, for agents that want to quote it in a body they compose.
 */
export const workflowIdempotency: IdempotencyHelper = {
  deriveActionKey: () => {
    throw new NonRetryableToolError(
      'idempotency',
      'action keys are derived inside the activity, not in workflow code',
    );
  },
  markerToken: (key) => key.slice(0, 12),
};

export function createWorkflowLogger(): AgentLogger {
  return {
    debug: (message, fields) => workflow.log.debug(message, fields),
    info: (message, fields) => workflow.log.info(message, fields),
    warn: (message, fields) => workflow.log.warn(message, fields),
    error: (message, fields) => workflow.log.error(message, fields),
  };
}

/** Recorder proxy: persistence is I/O, so every method is an activity. */
export function createWorkflowRecorder(executionId: string): ExecutionRecorder {
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new NonRetryableToolError(
      'recorder',
      `${name} is a runtime crash-recovery concern and is not callable from workflow code`,
    );
  };

  return {
    startStep: (input) =>
      acts.recorderStartStep({
        executionId,
        nodeId: input.nodeId,
        stepKey: input.stepKey,
        stepInstanceKey: input.stepInstanceKey,
        sequenceNo: input.sequenceNo,
        inputSummary: input.inputSummary ?? {},
      }),
    completeStep: (stepExecutionId, output) =>
      acts.recorderCompleteStep({ executionId, stepExecutionId, output }),
    failStep: (stepExecutionId, error) =>
      acts.recorderFailStep({ executionId, stepExecutionId, error }),
    appendEvidence: (stepExecutionId, payload, evidenceOptions) =>
      acts.recorderAppendEvidence({
        executionId,
        stepExecutionId,
        payload,
        ...(evidenceOptions?.eventKey === undefined ? {} : { eventKey: evidenceOptions.eventKey }),
      }),
    reserveAction: unsupported('reserveAction'),
    dispatchAction: unsupported('dispatchAction'),
    completeAction: unsupported('completeAction'),
    markActionForReconciliation: unsupported('markActionForReconciliation'),
    reconcileAction: unsupported('reconcileAction'),
    abandonAction: unsupported('abandonAction'),
  };
}
