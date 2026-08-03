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
      action: 'started' | 'signalled';
      executionId: string;
      businessKey: string;
      temporalWorkflowId: string;
      temporalRunId: string;
      wasExisting: boolean;
    };

/** `start_execution` is retried this many times before the row is left for the sweeper. */
export const START_EXECUTION_ATTEMPTS = 3;

interface ResolvedAgent {
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
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
    .select('spec_hash')
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
  };
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

  const previous = await findLatestExecution(deps.supabase, workflowId);

  // Whether this message joins the open case or opens a new one turns on whether the previous run
  // is still live, and nothing else. A live run is joined as it stands — recomputing a case key
  // would invent a second row for a workflow that `uq_executions_active_workflow` allows only one
  // of. A finished run is followed by a new case that names the one it came after, because the
  // workflow it belonged to has already reported its outcome and cannot take another message.
  const execution =
    previous !== null && previous.isLive
      ? { executionId: previous.executionId, wasExisting: true }
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
      messageRefs: [message.messageRef],
    },
    signalArg: message.messageRef,
  });

  await persistRunId(deps, execution.executionId, signalled.workflowId, signalled.runId);

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
