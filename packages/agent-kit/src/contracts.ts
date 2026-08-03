import type {
  ActionType,
  AgentDecision,
  ExecutionAction,
  ExecutionStep,
  MessageRef,
  ReconciliationEvidence,
} from '@meridian/core/schemas';
import type { z } from 'zod';

/**
 * The entire public surface a generated agent is allowed to see.
 *
 * This module is types and pure helpers only. Nothing reachable from here imports a provider SDK,
 * the Supabase client, the filesystem, or the wall clock, which is what makes it safe inside the
 * Temporal workflow sandbox. The ESLint rule that restricts `generated-agents/**` to this single
 * entry point is therefore enforcing a real boundary rather than a naming convention.
 */

export * from './agent.js';
export * from './capabilities.js';
export * from './chunk.js';
export * from './errors.js';
export * from './registry.js';
export * from './runner.js';

/**
 * The core schema types that appear in the signatures below are re-exported here.
 *
 * A generated agent may import from this module and nowhere else, so a type it must name in its own
 * code has to be reachable through it. Re-exporting is not a convenience: without it the boundary
 * rule would force generated code to either import `@meridian/core` directly, which the ESLint rule
 * forbids, or restate the type structurally, which would let the two definitions drift.
 */
export type {
  ActionType,
  AgentDecision,
  ExecutionAction,
  ExecutionStep,
  MessageRef,
  ReconciliationEvidence,
};

/** Workflow-safe clock. Inside a workflow this is `workflow.now()`, never `Date.now()`. */
export interface Clock {
  now(): number;
}

export interface AgentLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  bodyText: string;
  attachments: AttachmentRef[];
}

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string | null;
}

export interface OutboundMail {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  /**
   * Gmail accepts no client-supplied idempotency token, so the adapter appends
   * `[meridian-ref: <token>]` to the body. That footer is what a later reconciliation query
   * searches for, which is the only reason a duplicate can be recognised at all.
   */
  markerToken?: string;
}

export interface SentMail {
  providerMessageId: string;
  threadId: string;
}

export interface MailboxTool {
  searchMessages(query: string, maxResults?: number): Promise<MailMessage[]>;
  fetchThread(threadId: string): Promise<MailMessage[]>;
  downloadAttachments(threadId: string): Promise<AttachmentRef[]>;
  createDraft(payload: OutboundMail): Promise<{ draftId: string }>;
  sendDraft(draftId: string): Promise<SentMail>;
  sendMessage(payload: OutboundMail): Promise<SentMail>;
}

export interface BrowserTool {
  open(url: string): Promise<{ url: string; title: string }>;
  extractText(selector?: string): Promise<string>;
  download(url: string): Promise<AttachmentRef>;
  screenshot(): Promise<{ storagePath: string }>;
}

export interface FileRef {
  storagePath: string;
  filename: string;
  mimeType: string;
}

export interface DocumentTool {
  extractText(fileRef: FileRef): Promise<string>;
  extractFields(fileRef: FileRef, schemaName: string): Promise<Record<string, unknown>>;
  normalizeValue(value: string, type: 'hts' | 'ndc' | 'date' | 'number' | 'text'): Promise<string>;
}

export interface HumanHandoffTool {
  requestDecision(question: string, evidence: Record<string, unknown>): Promise<string>;
  waitForDecision(requestId: string): Promise<{ decision: string; notes: string | null }>;
}

export interface ToolRegistry {
  mailbox: MailboxTool;
  browser: BrowserTool;
  documents: DocumentTool;
  humanHandoff: HumanHandoffTool;
}

/**
 * Persistence, from the agent's point of view. Generated agents call only `reserveAction`,
 * `dispatchAction`, and `completeAction`; the three reconciliation methods belong to the runtime's
 * crash-recovery path, because deciding that a send may have escaped is a runtime concern rather
 * than a business-policy one.
 */
export interface ExecutionRecorder {
  startStep(input: {
    nodeId: string | null;
    stepKey: string;
    stepInstanceKey: string;
    sequenceNo: number;
    attemptNo?: number;
    inputSummary?: Record<string, unknown>;
  }): Promise<ExecutionStep>;
  completeStep(stepExecutionId: string, output: Record<string, unknown>): Promise<ExecutionStep>;
  failStep(stepExecutionId: string, error: Record<string, unknown>): Promise<ExecutionStep>;
  appendEvidence(
    stepExecutionId: string | null,
    payload: Record<string, unknown>,
    options?: { eventKey?: string; storagePath?: string },
  ): Promise<{ eventId: number }>;

  reserveAction(
    stepExecutionId: string | null,
    actionType: ActionType,
    payload: Record<string, unknown>,
  ): Promise<ExecutionAction>;
  dispatchAction(executionActionId: string): Promise<ExecutionAction>;
  completeAction(
    executionActionId: string,
    result: {
      status: 'succeeded' | 'failed';
      providerActionId?: string | null;
      response?: Record<string, unknown>;
    },
  ): Promise<ExecutionAction>;
  markActionForReconciliation(
    executionActionId: string,
    reason: Record<string, unknown>,
  ): Promise<ExecutionAction>;
  reconcileAction(
    executionActionId: string,
    outcome: 'succeeded' | 'reserved',
    providerActionId: string | null,
    evidence: ReconciliationEvidence,
  ): Promise<ExecutionAction>;
  abandonAction(
    executionActionId: string,
    reason: Record<string, unknown>,
  ): Promise<ExecutionAction>;
}

export interface IdempotencyHelper {
  deriveActionKey(input: {
    executionId: string;
    stepInstanceKey: string;
    actionType: string;
    payload: unknown;
  }): string;
  markerToken(key: string): string;
}

export interface AgentConfig {
  /** The resolved Composio toolkit version pinned for this run; never the literal `latest`. */
  toolkitVersions: Record<string, string>;
  operatorEmail: string;
  maxConcurrency: number;
  [key: string]: unknown;
}

export interface AgentContext {
  executionId: string;
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
  businessKey: string | null;
  capabilities: readonly string[];
  clock: Clock;
  logger: AgentLogger;
  toolRegistry: ToolRegistry;
  recorder: ExecutionRecorder;
  idempotency: IdempotencyHelper;
  config: AgentConfig;
}

/**
 * What a generated agent exports. It carries the spec hash it was generated from so the runtime
 * can refuse to run code that no longer matches the pinned specification.
 */
export interface AgentDefinition<TInput = unknown, TDecision = AgentDecision> {
  id: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  inputSchema: z.ZodType<TInput>;
  decisionSchema: z.ZodType<TDecision>;
  run(input: TInput, context: AgentContext): Promise<TDecision>;
}

export type AgentRegistry = Record<string, Record<number, AgentDefinition>>;

/** The pinned identity every workflow execution carries; a running workflow never upgrades. */
export interface PinnedVersion {
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
}

export interface WorkflowInput {
  executionId: string;
  businessKey: string;
  pinned: PinnedVersion;
  messageRef: MessageRef;
  config: AgentConfig;
}
