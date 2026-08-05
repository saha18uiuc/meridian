/**
 * The wire-level names shared by the worker that registers the workflow and the intake service
 * that starts it.
 *
 * These live in `core` rather than in the worker because the intake service must name the workflow
 * type without importing the workflow module — importing it would drag the whole activity graph,
 * and with it the provider SDKs, into the Next.js server bundle. Keeping the strings in one place
 * means a rename cannot silently desynchronise the two sides; `apps/backend/test/registry-bundle`
 * asserts the registered function name still matches.
 */

export const TEMPORAL_TASK_QUEUE = 'meridian-receiving';

/**
 * The queue this process should use: `TEMPORAL_TASK_QUEUE` if set, the constant above otherwise.
 *
 * One queue for the whole system was right while there was one system. Deployed, this machine and
 * Render share a Temporal Cloud namespace — the free tier allows only one — and a queue is the unit
 * of work distribution, so two workers polling the same name are handed each other's tasks. That
 * already happened: a local worker pointed at a local database won activities belonging to deployed
 * runs and failed them on foreign keys for rows it could not see, which reads as the deployed
 * environment being broken rather than as a laptop that should not have been listening.
 *
 * Read through a function rather than resolved into a constant at import time, because the workflow
 * bundle imports this module and a sandbox is not a place to be reading the environment.
 */
export function taskQueueName(source: Record<string, string | undefined> = process.env): string {
  const configured = source.TEMPORAL_TASK_QUEUE?.trim();
  return configured === undefined || configured === '' ? TEMPORAL_TASK_QUEUE : configured;
}

export const RECEIVING_WORKFLOW_TYPE = 'receivingWorkflow';

export const NEW_MESSAGE_SIGNAL = 'newMessage';

export const HUMAN_DECISION_SIGNAL = 'humanDecision';

/** `receiving:<normalized business key>`, derived before any Temporal call (§5.11 step 4). */
export function receivingWorkflowId(businessKey: string): string {
  return `receiving:${businessKey}`;
}

/**
 * The receiving workflow's single argument.
 *
 * It lives here, with the workflow type name, because the two sides of the call are compiled apart:
 * intake may not import the workflow module, and the worker may not import the intake service. A
 * shared type is the only thing that makes the wire contract checkable at all — typing the argument
 * as `Record<string, unknown>` at the boundary means an omitted field is a runtime failure inside a
 * workflow task, which surfaces as an execution stuck in `running` rather than as a compile error.
 *
 * Everything the run must not re-resolve later is pinned in here. `capabilities` comes from the
 * frozen spec of the pinned version, not from whatever the agent asks for at runtime, and
 * `toolkitVersion` is the concrete resolved version, never `latest`.
 */
export interface ReceivingWorkflowInput {
  executionId: string;
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
  businessKey: string;
  capabilities: string[];
  toolkitVersion: string;
  operatorEmail: string;
  maxConcurrency: number;
  messageRefs: MessageRefLike[];
}

/**
 * The message reference as it crosses the wire.
 *
 * Structural rather than an import of the Zod-inferred `MessageRef`, so this module stays free of
 * schema imports and can be pulled into the workflow bundle without dragging validation code in.
 * `apps/backend` checks the two are assignable.
 */
export interface MessageRefLike {
  provider: 'gmail' | 'mock';
  providerMessageId: string;
  threadId: string;
  subject: string;
  receivedAt: string;
  storagePath: string | null;
}
