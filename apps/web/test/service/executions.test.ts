import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@meridian/core/database';
import { HUMAN_DECISION_SIGNAL } from '@meridian/core/temporal-contract';
import { executionIdempotencyKey } from '@meridian/ops/intake';
import type { Client } from '@temporalio/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getExecutionDetail, submitHumanDecision } from '@/server/services/executions';
import {
  activeAgent,
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
} from './helpers';

/**
 * Reading an execution, and answering it.
 *
 * The detail view has one job that matters: report the version the run actually used, not the one
 * the agent points at today. Everything downstream — comparing a regression against the build that
 * passed, deciding whether to roll back — depends on those two never being confused. The human
 * decision path has a matching obligation: record the answer durably first, deliver it second, and
 * treat a run that has already finished as an answer that arrived late rather than one that failed.
 */

const EMAIL = 'executions-service@meridian.test';
const OTHER_EMAIL = 'executions-other@meridian.test';
const PASSWORD = 'meridian-test-password';

let service: SupabaseClient<Database>;
let owner: SupabaseClient<Database>;
let ownerId: string;
let agentId: string;
let agentVersionId: string;
let executionId: string;
let workflowId: string;

/** A Temporal stand-in that records the signals it is asked to deliver. */
function fakeTemporal(options: { notFound?: boolean } = {}): {
  client: Client;
  signals: { workflowId: string; name: string; payload: unknown }[];
} {
  const signals: { workflowId: string; name: string; payload: unknown }[] = [];
  const client = {
    workflow: {
      getHandle: vi.fn((id: string) => ({
        workflowId: id,
        signal: vi.fn(async (name: string, payload: unknown) => {
          if (options.notFound === true) {
            const error = new Error('workflow not found');
            error.name = 'WorkflowNotFoundError';
            throw error;
          }
          signals.push({ workflowId: id, name, payload });
        }),
      })),
    },
  } as unknown as Client;
  return { client, signals };
}

beforeAll(async () => {
  service = serviceClient();
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);

  const board = await createBoard(owner);
  const spec = await freezeBoard(service, ownerId, board.whiteboardId);
  ({ agentId, agentVersionId } = await activeAgent(
    service,
    owner,
    ownerId,
    board.whiteboardId,
    spec.specId,
    spec.specHash,
  ));

  const businessKey = `MSKU${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}0`;
  workflowId = `receiving-${businessKey}`;
  const caseKey = `live:${businessKey}`;
  const { data, error } = await service.rpc('create_execution', {
    p_agent_id: agentId,
    p_agent_version_id: agentVersionId,
    p_run_type: 'live',
    p_case_key: caseKey,
    p_business_key: businessKey,
    p_temporal_workflow_id: workflowId,
    p_idempotency_key: executionIdempotencyKey('live', businessKey, caseKey),
    p_input_ref: { specHash: spec.specHash } as unknown as Json,
  });
  if (error !== null) throw new Error(error.message);
  executionId = (data as unknown as { executionId: string }).executionId;

  const started = await service.rpc('start_execution', {
    p_execution_id: executionId,
    p_temporal_workflow_id: workflowId,
    p_temporal_run_id: randomUUID(),
  });
  if (started.error !== null) throw new Error(started.error.message);
});

describe('the execution detail view', () => {
  it('reports the version the run actually used', async () => {
    const detail = await getExecutionDetail(owner, executionId);
    expect(detail.execution.executionId).toBe(executionId);
    expect(detail.version.agentVersionId).toBe(agentVersionId);
    expect(detail.version.gitCommitSha).not.toBeNull();
    expect(detail.version.specHash).toHaveLength(64);
    expect(detail.agent.agentId).toBe(agentId);
    expect(detail.version.isActiveRelease).toBe(true);
  });

  it('keeps naming that version after the release pointer moves on', async () => {
    // This is the whole reason the pinned triple is recorded per execution. If the view resolved
    // the version through the agent, every historical run would appear to have used today's build.
    const paused = await service
      .from('agents')
      .update({ status: 'paused' })
      .eq('agent_id', agentId);
    expect(paused.error).toBeNull();
    const cleared = await service
      .from('agents')
      .update({ active_agent_version_id: null })
      .eq('agent_id', agentId);
    expect(cleared.error).toBeNull();

    const detail = await getExecutionDetail(owner, executionId);
    expect(detail.version.agentVersionId).toBe(agentVersionId);
    expect(detail.version.isActiveRelease).toBe(false);

    await service
      .from('agents')
      .update({ active_agent_version_id: agentVersionId, status: 'active' })
      .eq('agent_id', agentId);
  });

  it('does not exist for another user', async () => {
    await ensureUser(OTHER_EMAIL, PASSWORD);
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    // Row-level security makes this a 404 rather than a 403: the substituted identifier must not
    // even confirm that the execution is real.
    await expect(getExecutionDetail(other, executionId)).rejects.toThrow(/EXECUTION|not found/i);
  });
});

describe('answering a human decision', () => {
  it('records the answer and delivers it to the waiting run', async () => {
    const temporal = fakeTemporal();
    const requestId = randomUUID();
    const result = await submitHumanDecision(
      owner,
      executionId,
      { requestId, decision: 'approve', notes: 'Broker confirmed the HS code by phone.' },
      { temporal: temporal.client, service },
    );

    expect(result.workflowRunning).toBe(true);
    expect(temporal.signals).toHaveLength(1);
    expect(temporal.signals[0]?.workflowId).toBe(workflowId);
    expect(temporal.signals[0]?.name).toBe(HUMAN_DECISION_SIGNAL);
    expect(temporal.signals[0]?.payload).toMatchObject({ requestId, decision: 'approve' });

    const { data } = await service
      .from('execution_events')
      .select('event_type, event_key, payload_json')
      .eq('execution_id', executionId)
      .eq('event_key', `human-decision:${requestId}`);
    expect(data).toHaveLength(1);
    // `evidence`, not a state transition: the run learned something, it did not change status.
    expect(data?.[0]?.event_type).toBe('evidence');
    expect((data?.[0]?.payload_json as { decision: string }).decision).toBe('approve');
  });

  it('writes one event however many times the button is pressed', async () => {
    const temporal = fakeTemporal();
    const requestId = randomUUID();
    const answer = { requestId, decision: 'reject' as const, notes: null };
    await submitHumanDecision(owner, executionId, answer, {
      temporal: temporal.client,
      service,
    });
    await submitHumanDecision(owner, executionId, answer, {
      temporal: temporal.client,
      service,
    });

    const { data } = await service
      .from('execution_events')
      .select('event_id')
      .eq('execution_id', executionId)
      .eq('event_key', `human-decision:${requestId}`);
    // The signal may be delivered twice — the workflow's own condition has already resolved — but
    // the history must show one answer, or the audit trail suggests the operator changed their mind.
    expect(data).toHaveLength(1);
  });

  it('records the answer even when the run has already finished', async () => {
    const temporal = fakeTemporal({ notFound: true });
    const requestId = randomUUID();
    const result = await submitHumanDecision(
      owner,
      executionId,
      { requestId, decision: 'approve', notes: null },
      { temporal: temporal.client, service },
    );

    // Losing the answer would be the worse outcome: somebody made a decision, and the record of it
    // is worth keeping whether or not there is still a workflow interested in hearing it.
    expect(result.workflowRunning).toBe(false);
    const { data } = await service
      .from('execution_events')
      .select('event_id')
      .eq('execution_id', executionId)
      .eq('event_key', `human-decision:${requestId}`);
    expect(data).toHaveLength(1);
  });

  it('refuses an answer from someone who cannot see the execution', async () => {
    const temporal = fakeTemporal();
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    await expect(
      submitHumanDecision(
        other,
        executionId,
        { requestId: randomUUID(), decision: 'approve', notes: null },
        { temporal: temporal.client, service },
      ),
    ).rejects.toThrow(/EXECUTION|not found/i);
    // Ownership is checked before anything is written, so nothing was.
    expect(temporal.signals).toEqual([]);
  });
});
