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
 * One active execution per workflow ID (A24 step 9).
 *
 * `uq_executions_active_workflow` is a partial unique index over the non-terminal statuses, which
 * is what lets a business key be run again after the previous run finished while still making two
 * simultaneously-live rows impossible. A plain unique index would have forbidden the follow-up run
 * as well, and a check in application code would have lost the race it exists to prevent.
 */

let owner: string;
let agent: AgentFixture;

const BUSINESS_KEY = 'MSKU1234565';
const WORKFLOW_ID = `receiving:${BUSINESS_KEY}`;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

function create(caseKey: string, workflowId: string | null = WORKFLOW_ID) {
  return rpcAsService<{ executionId: string; wasExisting: boolean }>('create_execution', [
    agent.agentId,
    agent.agentVersionId,
    'live',
    caseKey,
    BUSINESS_KEY,
    workflowId,
    idempotencyKey('live', BUSINESS_KEY, caseKey),
    JSON.stringify({}),
  ]);
}

describe('uq_executions_active_workflow', () => {
  it('refuses a second non-terminal execution for the same workflow id', async () => {
    await create('live:first');
    await expectPgError(create('live:second'), 'uq_executions_active_workflow');
  });

  it('allows a new run once the previous execution is terminal', async () => {
    const first = await create('live:first');
    await rpcAsService('start_execution', [first.executionId, WORKFLOW_ID, 'run-1']);
    await rpcAsService('complete_execution', [
      first.executionId,
      'passed',
      JSON.stringify({ outcome: 'ready' }),
      null,
    ]);

    const second = await create('live:followup');
    expect(second.executionId).not.toBe(first.executionId);
  });

  it('links a follow-up run to the execution it succeeds', async () => {
    const first = await create('live:first');
    await rpcAsService('start_execution', [first.executionId, WORKFLOW_ID, 'run-1']);
    await rpcAsService('fail_execution', [first.executionId, JSON.stringify({ code: 'X' })]);

    const second = await rpcAsService<{ executionId: string }>('create_execution', [
      agent.agentId,
      agent.agentVersionId,
      'live',
      'live:followup',
      BUSINESS_KEY,
      WORKFLOW_ID,
      idempotencyKey('live', BUSINESS_KEY, 'live:followup'),
      JSON.stringify({ previousExecutionId: first.executionId, lateFollowUp: true }),
    ]);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ input_ref_json: Record<string, unknown> }>(
        'select input_ref_json from public.executions where execution_id = $1',
        [second.executionId],
      ),
    );
    expect(rows[0]?.input_ref_json).toMatchObject({
      previousExecutionId: first.executionId,
      lateFollowUp: true,
    });
  });

  it('does not constrain rows with no workflow id at all', async () => {
    // Manual-review intakes carry a NULL workflow ID, and there can be any number of those.
    await rpcAsService('create_manual_review_intake_execution', [
      agent.agentId,
      agent.agentVersionId,
      'intake:m1',
      idempotencyKey('live', '', 'intake:m1'),
      'NO_BUSINESS_KEY',
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify({ providerMessageId: 'm1' }),
    ]);
    await rpcAsService('create_manual_review_intake_execution', [
      agent.agentId,
      agent.agentVersionId,
      'intake:m2',
      idempotencyKey('live', '', 'intake:m2'),
      'NO_BUSINESS_KEY',
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify({ providerMessageId: 'm2' }),
    ]);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        'select count(*)::text as count from public.executions where temporal_workflow_id is null',
      ),
    );
    expect(rows[0]?.count).toBe('2');
  });
});

describe('the workflow id column', () => {
  it('may be filled in once but never changed', async () => {
    const created = await create('live:first', null);
    await asPostgres(async (client) =>
      client.query(
        'update public.executions set temporal_workflow_id = $2 where execution_id = $1',
        [created.executionId, WORKFLOW_ID],
      ),
    );
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.executions set temporal_workflow_id = $2 where execution_id = $1',
          [created.executionId, 'receiving:SOMETHING-ELSE'],
        ),
      ),
      'WORKFLOW_ID_IMMUTABLE',
    );
  });
});
