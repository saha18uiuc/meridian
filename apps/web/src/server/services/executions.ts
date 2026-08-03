import 'server-only';

import { sha256Hex } from '@meridian/core';
import type { Database } from '@meridian/core/database';
import type { HumanDecisionRequest } from '@meridian/core/schemas';
import { HUMAN_DECISION_SIGNAL } from '@meridian/core/temporal-contract';
import { appendEvent } from '@meridian/agent-kit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client as TemporalClient } from '@temporalio/client';
import { getAgent } from '@/server/repositories/agents';
import { getAgentVersion } from '@/server/repositories/agent-versions';
import { getExecution } from '@/server/repositories/executions';
import { temporalClient } from '@/server/services/intake';
import { createServiceClient } from '@/server/supabase/service-client';

/**
 * Reading an execution, and answering the one question a human can be asked mid-run.
 *
 * The detail view exists as a service rather than inline in the route because the interesting part
 * is not the row — it is the pinned triple of version, spec hash, and Git SHA that the run actually
 * used. That triple is assembled the same way for the API and for the eval diff, and assembling it
 * twice is how the two would come to disagree.
 */

type Client = SupabaseClient<Database>;

export interface ExecutionDetail {
  execution: Awaited<ReturnType<typeof getExecution>>;
  agent: Awaited<ReturnType<typeof getAgent>>;
  version: {
    agentVersionId: string;
    versionNo: number;
    specId: string;
    specHash: string | null;
    gitCommitSha: string | null;
    isActiveRelease: boolean;
  };
}

export async function getExecutionDetail(
  client: Client,
  executionId: string,
): Promise<ExecutionDetail> {
  const execution = await getExecution(client, executionId);
  const [version, agent] = await Promise.all([
    getAgentVersion(client, execution.agentVersionId),
    getAgent(client, execution.agentId),
  ]);
  const manifest = version.buildManifestJson as { specHash?: string };

  return {
    execution,
    agent,
    version: {
      agentVersionId: version.agentVersionId,
      versionNo: version.versionNo,
      specId: version.specId,
      specHash: manifest.specHash ?? null,
      gitCommitSha: version.gitCommitSha,
      // The release pointer is a property of the agent *now*, not of the run: an execution keeps
      // naming the version it used long after the pointer has moved on.
      isActiveRelease: agent.activeAgentVersionId === version.agentVersionId,
    },
  };
}

export interface SubmitHumanDecisionOptions {
  temporal?: TemporalClient;
  service?: Client;
}

export interface SubmitHumanDecisionResult {
  signalled: true;
  /** False when the run had already finished, in which case the answer is recorded but not sent. */
  workflowRunning: boolean;
}

/**
 * Deliver a human's answer to a waiting workflow, and record that it was given.
 *
 * Repeating the same `requestId` is a no-op from the workflow's point of view — its `condition` has
 * already resolved — so this returns 200 rather than an error. The event is still appended under an
 * idempotency key, so the history shows one answer no matter how many times the button was pressed.
 */
export async function submitHumanDecision(
  userClient: Client,
  executionId: string,
  request: HumanDecisionRequest,
  options: SubmitHumanDecisionOptions = {},
): Promise<SubmitHumanDecisionResult> {
  // Ownership is re-derived from the execution through the caller's own client before anything
  // privileged happens, exactly as on the intake path.
  const execution = await getExecution(userClient, executionId);

  const service = options.service ?? createServiceClient();
  await appendEvent(service, {
    executionId,
    stepExecutionId: null,
    // `evidence`, not `state_transition`: the execution's status does not change because a human
    // answered. What changed is that the run now holds a fact it did not have before.
    eventType: 'evidence',
    eventKey: `human-decision:${request.requestId}`,
    payload: {
      requestId: request.requestId,
      decision: request.decision,
      notes: request.notes ?? null,
    },
    // `ck_execution_events_idem_format` wants 64 hex characters, so the natural key is hashed
    // rather than written through. The hash is over the execution as well as the request, which
    // keeps two runs that were asked the same question from sharing one answer.
    idempotencyKey: sha256Hex(['human-decision', executionId, request.requestId].join('|')),
  });

  if (execution.temporalWorkflowId === null) {
    // An execution with no workflow is the intake manual-review path. There is nothing to signal,
    // and pretending otherwise would surface a Temporal "not found" as if the answer were lost.
    return { signalled: true, workflowRunning: false };
  }

  const temporal = options.temporal ?? (await temporalClient());
  const handle = temporal.workflow.getHandle(execution.temporalWorkflowId);
  try {
    await handle.signal(HUMAN_DECISION_SIGNAL, {
      requestId: request.requestId,
      decision: request.decision,
      notes: request.notes ?? null,
    });
    return { signalled: true, workflowRunning: true };
  } catch (error) {
    // A completed workflow cannot be signalled. The answer is already recorded above, so this is
    // reported as "not running" rather than as a failure the operator must act on.
    if ((error as { name?: string }).name === 'WorkflowNotFoundError') {
      return { signalled: true, workflowRunning: false };
    }
    throw error;
  }
}
