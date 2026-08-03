import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  truncateAll,
} from '../helpers/db.js';
import { type AgentFixture, idempotencyKey, seedActiveAgent } from '../helpers/lineage.js';

/**
 * The no-business-key path (A23).
 *
 * A message nobody can correlate is a completed run whose *outcome* is `manual_review` — not a
 * failure, and certainly not a workflow left running with nothing to wait for. Doing it in one
 * transaction is what stops the half-succeeded shape where an execution row exists but the
 * evidence explaining it does not.
 */

let owner: string;
let agent: AgentFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

const messageRef = { provider: 'gmail', providerMessageId: 'msg-1', threadId: 't-1' };

function intake(
  reason: 'NO_BUSINESS_KEY' | 'CONFLICTING_BUSINESS_KEYS' = 'NO_BUSINESS_KEY',
  candidates: string[] = [],
  caseKey = 'intake:msg-1',
): Promise<{ executionId: string; wasExisting: boolean; outcome: string; reason: string }> {
  return rpcAsService('create_manual_review_intake_execution', [
    agent.agentId,
    agent.agentVersionId,
    caseKey,
    idempotencyKey('live', '', caseKey),
    reason,
    JSON.stringify(candidates),
    JSON.stringify({ messageRef }),
    JSON.stringify(messageRef),
  ]);
}

async function executionRow(executionId: string): Promise<{
  status: string;
  business_key: string | null;
  temporal_workflow_id: string | null;
  temporal_run_id: string | null;
  completed_at: string | null;
  output_summary_json: Record<string, unknown>;
}> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{
      status: string;
      business_key: string | null;
      temporal_workflow_id: string | null;
      temporal_run_id: string | null;
      completed_at: string | null;
      output_summary_json: Record<string, unknown>;
    }>(
      `select status, business_key, temporal_workflow_id, temporal_run_id, completed_at,
              output_summary_json
         from public.executions where execution_id = $1`,
      [executionId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('execution disappeared');
  return row;
}

describe('create_manual_review_intake_execution', () => {
  it('writes a terminal row with no business key and no workflow', async () => {
    const result = await intake();
    const row = await executionRow(result.executionId);
    expect(row).toMatchObject({
      status: 'passed',
      business_key: null,
      temporal_workflow_id: null,
      temporal_run_id: null,
    });
    expect(row.completed_at).not.toBeNull();
  });

  it('records the outcome as manual_review rather than as a failure', async () => {
    const result = await intake();
    // The run did what it could and stopped honestly. Marking it `error` would put a real
    // operational fault and an uncorrelatable email in the same bucket.
    expect((await executionRow(result.executionId)).output_summary_json).toMatchObject({
      outcome: 'manual_review',
      reason: 'NO_BUSINESS_KEY',
      candidates: [],
    });
  });

  it('carries the candidate list for a conflict', async () => {
    const result = await intake(
      'CONFLICTING_BUSINESS_KEYS',
      ['MSKU1234565', 'TGHU7654320'],
      'intake:c',
    );
    expect((await executionRow(result.executionId)).output_summary_json).toMatchObject({
      reason: 'CONFLICTING_BUSINESS_KEYS',
      candidates: ['MSKU1234565', 'TGHU7654320'],
    });
  });

  it('writes the message reference as an evidence event in the same transaction', async () => {
    const result = await intake();
    const { rows } = await asPostgres(async (client) =>
      client.query<{
        event_type: string;
        event_key: string;
        payload_json: Record<string, unknown>;
      }>(
        'select event_type, event_key, payload_json from public.execution_events where execution_id = $1 order by event_id',
        [result.executionId],
      ),
    );
    expect(rows[0]).toMatchObject({ event_type: 'evidence', event_key: 'message:msg-1' });
    expect(rows[0]?.payload_json).toMatchObject({ providerMessageId: 'msg-1' });
    expect(rows[1]).toMatchObject({
      event_type: 'state_transition',
      event_key: 'execution:manual_review',
    });
  });

  it('is idempotent, so a redelivered message does not create a second review item', async () => {
    const first = await intake();
    const second = await intake();
    expect(second).toMatchObject({ executionId: first.executionId, wasExisting: true });
  });

  it('rejects a reason outside the two defined ones', async () => {
    await expectPgError(
      rpcAsService('create_manual_review_intake_execution', [
        agent.agentId,
        agent.agentVersionId,
        'intake:bad',
        idempotencyKey('live', '', 'intake:bad'),
        'I_DONT_LIKE_IT',
        JSON.stringify([]),
        JSON.stringify({}),
        JSON.stringify(messageRef),
      ]),
      'INVALID_MANUAL_REVIEW_REASON',
    );
  });

  it('still pins the agent and version lineage', async () => {
    const result = await intake();
    const { rows } = await asPostgres(async (client) =>
      client.query<{ agent_id: string; agent_version_id: string }>(
        'select agent_id, agent_version_id from public.executions where execution_id = $1',
        [result.executionId],
      ),
    );
    expect(rows[0]).toMatchObject({
      agent_id: agent.agentId,
      agent_version_id: agent.agentVersionId,
    });
  });
});
