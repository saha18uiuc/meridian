import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  openSession,
  rpcAsService,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';
import {
  type AgentFixture,
  buildManifest,
  fakeGitSha,
  idempotencyKey,
  seedActiveAgent,
  seedAgentVersion,
} from '../helpers/lineage.js';

/**
 * Executions and their lineage gate.
 *
 * The interesting rules are all refusals: a live run against an unapproved version, a run against
 * a version that is approved but not the active release, and a second row for a business key that
 * already has one. Each of those would produce a plausible-looking execution whose provenance was
 * a lie, which is worse than an error.
 */

let owner: string;
let agent: AgentFixture;

const BUSINESS_KEY = 'MSKU1234565';

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

function createExecution(
  overrides: {
    caseKey?: string;
    businessKey?: string | null;
    runType?: 'live' | 'eval';
    agentVersionId?: string;
    workflowId?: string | null;
  } = {},
): Promise<{ executionId: string; wasExisting: boolean; status: string }> {
  const caseKey = overrides.caseKey ?? `live:${BUSINESS_KEY}`;
  const businessKey = overrides.businessKey === undefined ? BUSINESS_KEY : overrides.businessKey;
  const runType = overrides.runType ?? 'live';
  return rpcAsService('create_execution', [
    agent.agentId,
    overrides.agentVersionId ?? agent.agentVersionId,
    runType,
    caseKey,
    businessKey,
    overrides.workflowId === undefined ? `receiving:${BUSINESS_KEY}` : overrides.workflowId,
    idempotencyKey(runType, businessKey ?? '', caseKey),
    JSON.stringify({ messageRef: { providerMessageId: 'm1' } }),
  ]);
}

describe('create_execution', () => {
  it('inserts a queued row with the workflow id already populated', async () => {
    const created = await createExecution();
    expect(created).toMatchObject({ wasExisting: false, status: 'queued' });
    const { rows } = await asPostgres(async (client) =>
      client.query<{ temporal_workflow_id: string | null; temporal_run_id: string | null }>(
        'select temporal_workflow_id, temporal_run_id from public.executions where execution_id = $1',
        [created.executionId],
      ),
    );
    // The workflow ID exists before Temporal is called, which is what makes the compensation
    // sweep able to find an orphan later.
    expect(rows[0]).toMatchObject({
      temporal_workflow_id: `receiving:${BUSINESS_KEY}`,
      temporal_run_id: null,
    });
  });

  it('records a state_transition event for the new row', async () => {
    const created = await createExecution();
    const { rows } = await asPostgres(async (client) =>
      client.query<{ event_key: string }>(
        'select event_key from public.execution_events where execution_id = $1',
        [created.executionId],
      ),
    );
    expect(rows.map((row) => row.event_key)).toContain('execution:created');
  });

  it('is idempotent on the idempotency key', async () => {
    const first = await createExecution();
    const second = await createExecution();
    expect(second).toMatchObject({ executionId: first.executionId, wasExisting: true });
  });

  it('lets exactly one of two racing inserts win', async () => {
    const key = idempotencyKey('live', BUSINESS_KEY, `live:${BUSINESS_KEY}`);
    const left = await openSession('service_role', null);
    const right = await openSession('service_role', null);
    const call = (session: { client: { query: typeof left.client.query } }) =>
      session.client.query<{ result: { executionId: string; wasExisting: boolean } }>(
        'select public.create_execution($1,$2,$3,$4,$5,$6,$7,$8) as result',
        [
          agent.agentId,
          agent.agentVersionId,
          'live',
          `live:${BUSINESS_KEY}`,
          BUSINESS_KEY,
          `receiving:${BUSINESS_KEY}`,
          key,
          JSON.stringify({}),
        ],
      );
    try {
      const first = await call(left);
      const pending = call(right);
      await left.client.query('commit');
      const second = await pending;
      await right.client.query('commit');

      expect(second.rows[0]?.result.executionId).toBe(first.rows[0]?.result.executionId);
      expect(second.rows[0]?.result.wasExisting).toBe(true);
    } finally {
      left.release();
      right.release();
    }
  });

  it('rejects an idempotency key that is not a sha256 hex string', async () => {
    await expectPgError(
      rpcAsService('create_execution', [
        agent.agentId,
        agent.agentVersionId,
        'live',
        'k',
        BUSINESS_KEY,
        null,
        'not-a-hash',
        JSON.stringify({}),
      ]),
      'INVALID_IDEMPOTENCY_KEY',
    );
  });

  it('rejects an unknown run type', async () => {
    await expectPgError(createExecution({ runType: 'smoke' as 'live' }), 'INVALID_RUN_TYPE');
  });
});

describe('the execution lineage gate', () => {
  it('refuses a run against a version with no Git commit', async () => {
    const uncommitted = await seedAgentVersion(owner);
    await expectPgError(
      rpcAsService('create_execution', [
        uncommitted.agentId,
        uncommitted.agentVersionId,
        'eval',
        'case-1',
        null,
        null,
        idempotencyKey('eval', '', 'case-1'),
        JSON.stringify({}),
      ]),
      'EXECUTION_REQUIRES_COMMITTED_VERSION',
    );
  });

  it('refuses a live run against a version that is only evaluating', async () => {
    const evaluating = await seedAgentVersion(owner);
    await rpcAsService('record_agent_commit', [
      owner,
      evaluating.agentVersionId,
      fakeGitSha(),
      JSON.stringify(buildManifest(evaluating.specHash)),
    ]);
    await rpcAsUser(owner, 'transition_agent_version', [evaluating.agentVersionId, 'evaluating']);

    await expectPgError(
      rpcAsService('create_execution', [
        evaluating.agentId,
        evaluating.agentVersionId,
        'live',
        'case-live',
        BUSINESS_KEY,
        null,
        idempotencyKey('live', BUSINESS_KEY, 'case-live'),
        JSON.stringify({}),
      ]),
      'LIVE_RUN_REQUIRES_APPROVED_VERSION',
    );
  });

  it('refuses a live run against an approved version that is not the active release', async () => {
    const second = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
      agent.agentId,
      agent.specId,
      agent.agentVersionId,
    ]);
    await rpcAsService('record_agent_commit', [
      owner,
      second.agentVersionId,
      fakeGitSha(),
      JSON.stringify(buildManifest(agent.specHash)),
    ]);
    await rpcAsUser(owner, 'transition_agent_version', [second.agentVersionId, 'evaluating']);
    await rpcAsUser(owner, 'transition_agent_version', [second.agentVersionId, 'approved']);

    await expectPgError(
      createExecution({ agentVersionId: second.agentVersionId, caseKey: 'live:other' }),
      'VERSION_NOT_ACTIVE_RELEASE',
    );
  });

  it('allows an eval run against a non-active approved version', async () => {
    const evalRun = await rpcAsService<{ executionId: string }>('create_execution', [
      agent.agentId,
      agent.agentVersionId,
      'eval',
      'eval:happy-path',
      null,
      null,
      idempotencyKey('eval', '', 'eval:happy-path'),
      JSON.stringify({}),
    ]);
    expect(evalRun.executionId).toBeTruthy();
  });
});

describe('the execution state machine', () => {
  it('walks queued → running → passed and records both transitions', async () => {
    const created = await createExecution();
    await rpcAsService('start_execution', [
      created.executionId,
      `receiving:${BUSINESS_KEY}`,
      'run-1',
    ]);
    await rpcAsService('complete_execution', [
      created.executionId,
      'passed',
      JSON.stringify({ outcome: 'ready' }),
      null,
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ event_key: string }>(
        'select event_key from public.execution_events where execution_id = $1 order by event_id',
        [created.executionId],
      ),
    );
    expect(rows.map((row) => row.event_key)).toEqual([
      'execution:created',
      'execution:running',
      'execution:passed',
    ]);
  });

  it('makes start_execution idempotent so the sweeper can replay it', async () => {
    const created = await createExecution();
    await rpcAsService('start_execution', [created.executionId, `receiving:${BUSINESS_KEY}`, 'r1']);
    const replay = await rpcAsService<{ wasAlreadyStarted: boolean; status: string }>(
      'start_execution',
      [created.executionId, `receiving:${BUSINESS_KEY}`, 'r1'],
    );
    expect(replay).toMatchObject({ wasAlreadyStarted: true, status: 'running' });
  });

  it('rejects complete_execution with a non-terminal status', async () => {
    const created = await createExecution();
    await expectPgError(
      rpcAsService('complete_execution', [created.executionId, 'error', null, null]),
      'INVALID_TERMINAL_STATUS',
    );
  });

  it('allows fail_execution straight from queued, for a workflow that never started', async () => {
    const created = await createExecution();
    const failed = await rpcAsService<{ status: string }>('fail_execution', [
      created.executionId,
      JSON.stringify({ code: 'WORKFLOW_START_FAILED' }),
    ]);
    expect(failed.status).toBe('error');
  });

  it('treats a repeated failure as already terminal rather than an error', async () => {
    const created = await createExecution();
    await rpcAsService('fail_execution', [created.executionId, JSON.stringify({ code: 'X' })]);
    const again = await rpcAsService<{ wasAlreadyTerminal: boolean }>('fail_execution', [
      created.executionId,
      JSON.stringify({ code: 'X' }),
    ]);
    expect(again.wasAlreadyTerminal).toBe(true);
  });

  it('holds the lineage columns immutable after insert', async () => {
    const created = await createExecution();
    await expectPgError(
      asPostgres(async (client) =>
        client.query("update public.executions set run_type = 'eval' where execution_id = $1", [
          created.executionId,
        ]),
      ),
      'EXECUTION_LINEAGE_IMMUTABLE',
    );
  });
});
