import { appendEvent } from '@meridian/agent-kit';
import { workerEnv } from '@meridian/core';
import { canonicalJson, sha256Hex } from '@meridian/core/hashing';
import type { Database } from '@meridian/core/database';
import type { MessageRef } from '@meridian/core/schemas';
import { receivingWorkflowId } from '@meridian/core/temporal-contract';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client } from '@temporalio/client';
import { type ExtractionSource, extractBusinessKey } from './extract-business-key.js';
import { signalWithStartReceiving } from './signal-with-start.js';

export * from './extract-business-key.js';
export * from './reconcile-queued-executions.js';
export * from './signal-with-start.js';

/**
 * Correlation intake (§5.11), the single entry point for "an email arrived".
 *
 * The ordering here is the whole design. The business key is extracted first, the workflow ID is
 * derived from it second, the `executions` row is written third, and only then does Temporal hear
 * about any of it. Every one of those steps is recoverable on its own, and the one irrecoverable
 * arrangement — a workflow that exists with no row naming it — is made impossible by writing the
 * row first.
 */

export interface IntakeMessage {
  messageRef: MessageRef;
  /** Message text used for key extraction; kept separate from the reference stored as evidence. */
  content: ExtractionSource;
}

export interface IntakeDeps {
  supabase: SupabaseClient<Database>;
  temporal: Client;
  logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  /** Injected for tests; production uses real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; production reads the worker environment. */
  runtime?: RuntimeSettings;
}

/**
 * The environment-derived half of the workflow argument.
 *
 * Read once, at intake, and pinned into the argument. The workflow cannot read the environment
 * itself without breaking replay determinism, and an activity that re-read it could quietly change
 * the toolkit version or the fan-out width in the middle of a run.
 */
export interface RuntimeSettings {
  toolkitVersion: string;
  operatorEmail: string;
  maxConcurrency: number;
}

export function runtimeFromEnv(): RuntimeSettings {
  const env = workerEnv();
  return {
    toolkitVersion: env.COMPOSIO_GMAIL_TOOLKIT_VERSION,
    operatorEmail: env.OPERATOR_EMAIL,
    maxConcurrency: env.AGENT_MAX_CONCURRENCY,
  };
}

export type IntakeResult =
  | {
      action: 'manual_review';
      executionId: string;
      reason: 'NO_BUSINESS_KEY' | 'CONFLICTING_BUSINESS_KEYS';
      candidates: string[];
      wasExisting: boolean;
    }
  | {
      action: 'started' | 'signalled' | 'already_processed';
      executionId: string;
      businessKey: string;
      temporalWorkflowId: string;
      /** Null only for `already_processed` rows whose run ID was never recorded. */
      temporalRunId: string | null;
      wasExisting: boolean;
    };

/** `start_execution` is retried this many times before the row is left for the sweeper. */
export const START_EXECUTION_ATTEMPTS = 3;

/** How patient intake is with a run that is open but cannot be joined, before signalling it anyway. */
export const RUN_SETTLE_ATTEMPTS = 5;
export const RUN_SETTLE_INTERVAL_MS = 200;

interface ResolvedAgent {
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
  /** The allow-list carried by the frozen spec, which is the only place it may come from. */
  capabilities: string[];
}

export async function resolveActiveAgent(
  supabase: SupabaseClient<Database>,
  agentId: string,
): Promise<ResolvedAgent> {
  // Two reads rather than one embedded read. `agents` and `agent_versions` are joined by two
  // different foreign keys — the lineage key and the active-version pointer — and both of those are
  // composite, so PostgREST cannot pick an embedding without a hint and the hint is fragile against
  // constraint renames. Reading the pointer and then reading the row it points at says the same
  // thing in terms the schema cache cannot misread.
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('agent_id, deployment_key, active_agent_version_id')
    .eq('agent_id', agentId)
    .single();
  if (agentError !== null) {
    throw new Error(`Could not load agent ${agentId}: ${agentError.message}`);
  }

  const activeId = agent.active_agent_version_id;
  if (activeId === null) {
    // Refusing here is deliberate: running "the newest version" when no version has been activated
    // would quietly bypass the approval gate that activation exists to enforce.
    throw new Error(`Agent ${agentId} has no active version; activate one before intake.`);
  }

  const { data: version, error: versionError } = await supabase
    .from('agent_versions')
    .select('agent_version_id, version_no, git_commit_sha, spec_id')
    .eq('agent_version_id', activeId)
    .single();
  if (versionError !== null) {
    throw new Error(`Could not load active version ${activeId}: ${versionError.message}`);
  }

  const { data: spec, error: specError } = await supabase
    .from('frozen_specs')
    .select('spec_hash, spec_json')
    .eq('spec_id', version.spec_id)
    .single();
  if (specError !== null) {
    throw new Error(`Active version ${activeId} has no frozen spec: ${specError.message}`);
  }

  return {
    agentId: agent.agent_id,
    agentVersionId: version.agent_version_id,
    deploymentKey: agent.deployment_key,
    versionNo: version.version_no,
    specHash: spec.spec_hash,
    gitCommitSha: version.git_commit_sha,
    capabilities: specCapabilities(spec.spec_json),
  };
}

/**
 * The capability allow-list, read from the frozen spec rather than from configuration.
 *
 * A run may use exactly what the contract it was compiled from asked for. Taking the list from the
 * environment, or letting the agent name its own, would make the allow-list a property of the
 * machine rather than of the approved specification, and the enforcement in `assertCapability`
 * would then be checking the agent against itself.
 */
function specCapabilities(specJson: unknown): string[] {
  if (typeof specJson !== 'object' || specJson === null) return [];
  const capabilities = (specJson as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) return [];
  return capabilities.filter((entry): entry is string => typeof entry === 'string');
}

/** `sha256(runType | businessKey | caseKey)`, the shape the `executions` unique key expects. */
export function executionIdempotencyKey(
  runType: 'live' | 'eval',
  businessKey: string | null,
  caseKey: string,
): string {
  return sha256Hex([runType, businessKey ?? '', caseKey].join('|'));
}

export async function intakeMessage(
  deps: IntakeDeps,
  agentId: string,
  message: IntakeMessage,
): Promise<IntakeResult> {
  const agent = await resolveActiveAgent(deps.supabase, agentId);
  const runtime = deps.runtime ?? runtimeFromEnv();
  const extraction = extractBusinessKey(message.content);

  if (extraction.kind !== 'ok') {
    const reason = extraction.kind === 'none' ? 'NO_BUSINESS_KEY' : 'CONFLICTING_BUSINESS_KEYS';
    const candidates = extraction.candidates.map((candidate) => candidate.value);
    // The case key is derived from the message, not the (absent) business key, so redelivering the
    // same email lands on the same terminal row instead of creating a second manual-review item.
    const caseKey = `intake:${message.messageRef.providerMessageId}`;
    const { data, error } = await deps.supabase.rpc('create_manual_review_intake_execution', {
      p_agent_id: agent.agentId,
      p_agent_version_id: agent.agentVersionId,
      p_case_key: caseKey,
      p_idempotency_key: executionIdempotencyKey('live', null, caseKey),
      p_reason: reason,
      p_candidates: candidates,
      p_input_ref: { messageRef: message.messageRef, specHash: agent.specHash },
      p_message_ref: message.messageRef,
    });
    if (error !== null) throw new Error(`create_manual_review_intake_execution: ${error.message}`);
    const result = data as { executionId: string; wasExisting: boolean };
    deps.logger?.info(
      { reason, candidates },
      'intake routed to manual review; no workflow started',
    );
    return {
      action: 'manual_review',
      executionId: result.executionId,
      reason,
      candidates,
      wasExisting: result.wasExisting,
    };
  }

  const businessKey = extraction.businessKey;
  // Step 4: the workflow ID exists before any Temporal call, which is what makes step 6 atomic.
  const workflowId = receivingWorkflowId(businessKey);

  // Has this exact email been taken in before? The question is answered from the ingest log rather
  // than from the case key, because the case key of a first message and the case key of a late
  // follow-up differ by design, and a redelivery of the first message would otherwise be
  // indistinguishable from a new document arriving after the case closed. Re-running a shipment
  // re-sends whatever the first run sent, so this is not a distinction worth guessing at.
  const ingested = await findIngestedMessage(deps.supabase, message.messageRef.providerMessageId);
  if (ingested !== null && !ingested.isLive) {
    deps.logger?.info(
      {
        executionId: ingested.executionId,
        providerMessageId: message.messageRef.providerMessageId,
      },
      'message already processed; no workflow started',
    );
    return {
      action: 'already_processed',
      executionId: ingested.executionId,
      businessKey,
      temporalWorkflowId: workflowId,
      temporalRunId: ingested.temporalRunId,
      wasExisting: true,
    };
  }

  const previous = await findLatestExecution(deps.supabase, workflowId);

  // Temporal is asked whether a run is open, rather than inferring it from the row's status.
  //
  // The two can disagree, and the disagreement is not theoretical: it is the window between a
  // workflow writing its terminal status and the run actually closing. Reading only the row, intake
  // sees "finished", writes a new execution, and calls `signalWithStart` — which finds the old run
  // still open, applies USE_EXISTING, and delivers the message to a workflow that is carrying a
  // different execution ID. The row just written is then named by no workflow and sits in `running`
  // until something sweeps it. Asking the server closes that window at its source.
  const openRunId = await openRunFor(deps.temporal, workflowId);

  // Whether this message joins the open case or opens a new one turns on whether the run recorded
  // for the previous execution is the run Temporal still has open. A live run is joined as it
  // stands — recomputing a case key would invent a second row for a workflow that
  // `uq_executions_active_workflow` allows only one of. A closed run is followed by a new case that
  // names the one it came after, because the workflow it belonged to has already reported its
  // outcome and cannot take another message.
  let host = openRunId !== null && previous?.temporalRunId === openRunId ? previous : null;

  if (host === null && openRunId !== null) {
    // A run is open that no known row names — a concurrent intake is mid-flight, or a run is in the
    // act of closing. Either way, creating a row from here would produce exactly the orphan
    // described above, so intake waits for the server to settle and looks once more.
    await awaitRunSettled(deps, workflowId, openRunId);
    const current = await findLatestExecution(deps.supabase, workflowId);
    if (current !== null && current.temporalRunId === openRunId && current.isLive) host = current;
  }

  const execution =
    host !== null
      ? { executionId: host.executionId, wasExisting: true }
      : await createLiveExecution(deps, agent, businessKey, workflowId, message, previous);

  const signalled = await signalWithStartReceiving({
    client: deps.temporal,
    workflowId,
    knownRunId: previous?.temporalRunId ?? null,
    input: {
      executionId: execution.executionId,
      agentId: agent.agentId,
      agentVersionId: agent.agentVersionId,
      deploymentKey: agent.deploymentKey,
      versionNo: agent.versionNo,
      specHash: agent.specHash,
      gitCommitSha: agent.gitCommitSha,
      businessKey,
      capabilities: agent.capabilities,
      // Resolved here, at the one place that knows both the pinned version and the running
      // environment, and then frozen into the workflow argument. A workflow that read the
      // environment itself would be non-deterministic on replay, and one that re-read it per
      // activity could change toolkit mid-run.
      toolkitVersion: runtime.toolkitVersion,
      operatorEmail: runtime.operatorEmail,
      maxConcurrency: runtime.maxConcurrency,
      messageRefs: [message.messageRef],
    },
    signalArg: message.messageRef,
  });

  await persistRunId(deps, execution.executionId, signalled.workflowId, signalled.runId);
  await recordIngest(deps, execution.executionId, message.messageRef);

  return {
    action: signalled.wasAlreadyRunning ? 'signalled' : 'started',
    executionId: execution.executionId,
    businessKey,
    temporalWorkflowId: signalled.workflowId,
    temporalRunId: signalled.runId,
    wasExisting: execution.wasExisting,
  };
}

interface PriorExecution {
  executionId: string;
  temporalRunId: string | null;
  /** `queued` and `running` are exactly the statuses `uq_executions_active_workflow` reserves. */
  isLive: boolean;
}

async function findLatestExecution(
  supabase: SupabaseClient<Database>,
  workflowId: string,
): Promise<PriorExecution | null> {
  const { data, error } = await supabase
    .from('executions')
    .select('execution_id, temporal_run_id, status')
    .eq('temporal_workflow_id', workflowId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error !== null) throw new Error(`Could not read prior executions: ${error.message}`);
  const row = data?.[0];
  if (row === undefined) return null;
  return {
    executionId: row.execution_id,
    temporalRunId: row.temporal_run_id,
    isLive: row.status === 'queued' || row.status === 'running',
  };
}

/** The event key under which intake records that a message was taken in. */
export function messageIngestEventKey(providerMessageId: string): string {
  return `message:ingested:${providerMessageId}`;
}

/**
 * Record that this message was taken into this execution.
 *
 * The event is the correlation log: it is what lets a later delivery of the same email be
 * recognised as a redelivery, and it is also the honest answer to "which messages does this case
 * consist of?", which is otherwise only visible inside the workflow's history. It is appended after
 * the run ID is recorded, so an ingest that is written is one that genuinely reached a workflow.
 */
async function recordIngest(
  deps: IntakeDeps,
  executionId: string,
  messageRef: MessageRef,
): Promise<void> {
  const eventKey = messageIngestEventKey(messageRef.providerMessageId);
  try {
    await appendEvent(deps.supabase, {
      executionId,
      stepExecutionId: null,
      eventType: 'evidence',
      eventKey,
      payload: { ...messageRef },
      idempotencyKey: sha256Hex(['message-ingested', executionId, eventKey].join('|')),
    });
  } catch (error) {
    // Not fatal. The workflow already has the message, and losing the log entry costs a redelivery
    // check, not the run — reporting failure here would make intake look lost when it was not.
    deps.logger?.error(
      { code: 'INGEST_LOG_FAILED', executionId, eventKey, error },
      'the message was correlated but its ingest could not be logged',
    );
  }
}

/** The execution that already took this message in, if any, with the liveness of that execution. */
async function findIngestedMessage(
  supabase: SupabaseClient<Database>,
  providerMessageId: string,
): Promise<PriorExecution | null> {
  const { data, error } = await supabase
    .from('execution_events')
    .select('execution_id, executions!inner(status, temporal_run_id)')
    .eq('event_key', messageIngestEventKey(providerMessageId))
    .order('created_at', { ascending: false })
    .limit(1);
  if (error !== null) throw new Error(`Could not read the ingest log: ${error.message}`);
  const row = data?.[0];
  if (row === undefined) return null;
  return {
    executionId: row.execution_id,
    temporalRunId: row.executions.temporal_run_id,
    isLive: row.executions.status === 'queued' || row.executions.status === 'running',
  };
}

/** The run ID Temporal currently has open for this workflow ID, or null if none is running. */
async function openRunFor(temporal: Client, workflowId: string): Promise<string | null> {
  try {
    const described = await temporal.workflow.getHandle(workflowId).describe();
    return described.status.name === 'RUNNING' ? described.runId : null;
  } catch (error) {
    // No workflow by that ID has ever existed, which is the ordinary first-message case.
    if ((error as { name?: string }).name === 'WorkflowNotFoundError') return null;
    throw error;
  }
}

/**
 * Give a run that is open, but not the one this intake can join, a bounded moment to close.
 *
 * Bounded and best-effort on purpose. If the run is genuinely still working when the budget runs
 * out, `signalWithStart` will deliver to it under USE_EXISTING and the message is handled by the
 * run that is already reading the same thread — late, but not lost, and the row this intake would
 * otherwise have stranded is never written.
 */
async function awaitRunSettled(deps: IntakeDeps, workflowId: string, runId: string): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < RUN_SETTLE_ATTEMPTS; attempt += 1) {
    await sleep(RUN_SETTLE_INTERVAL_MS);
    const open = await openRunFor(deps.temporal, workflowId);
    if (open !== runId) return;
  }
}

async function createLiveExecution(
  deps: IntakeDeps,
  agent: ResolvedAgent,
  businessKey: string,
  workflowId: string,
  message: IntakeMessage,
  previous: PriorExecution | null,
): Promise<{ executionId: string; wasExisting: boolean }> {
  const caseKey =
    previous === null
      ? `live:${businessKey}`
      : `live:${businessKey}:followup:${message.messageRef.providerMessageId}`;

  const { data, error } = await deps.supabase.rpc('create_execution', {
    p_agent_id: agent.agentId,
    p_agent_version_id: agent.agentVersionId,
    p_run_type: 'live',
    p_case_key: caseKey,
    p_business_key: businessKey,
    p_temporal_workflow_id: workflowId,
    p_idempotency_key: executionIdempotencyKey('live', businessKey, caseKey),
    p_input_ref: {
      messageRef: message.messageRef,
      specHash: agent.specHash,
      gitCommitSha: agent.gitCommitSha,
      ...(previous === null
        ? {}
        : { previousExecutionId: previous.executionId, lateFollowUp: true }),
    },
  });
  if (error !== null) throw new Error(`create_execution: ${error.message}`);
  return data as unknown as { executionId: string; wasExisting: boolean };
}

/**
 * Step 7 with the bounded retry from step 8. Exhausting the retries is not a data-loss event: the
 * row is already durable in `queued` with the right workflow ID, and the sweeper finishes the job.
 */
async function persistRunId(
  deps: IntakeDeps,
  executionId: string,
  workflowId: string,
  runId: string,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= START_EXECUTION_ATTEMPTS; attempt += 1) {
    const { error } = await deps.supabase.rpc('start_execution', {
      p_execution_id: executionId,
      p_temporal_workflow_id: workflowId,
      p_temporal_run_id: runId,
    });
    if (error === null) return;
    lastError = error;
    if (attempt < START_EXECUTION_ATTEMPTS) await sleep(100 * 2 ** (attempt - 1));
  }

  deps.logger?.error(
    { code: 'INTAKE_DB_UPDATE_FAILED', executionId, workflowId, runId, lastError },
    'the workflow is running but its run ID could not be recorded; the sweeper will reconcile it',
  );
  throw new Error(`INTAKE_DB_UPDATE_FAILED: ${executionId} / ${workflowId}`);
}

/** Canonical JSON is re-exported so intake callers hash payloads the same way the RPCs expect. */
export { canonicalJson };
