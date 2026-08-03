import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  truncateAll,
} from '../helpers/db.js';
import { seedActiveAgent, seedExecutionWithStep, type AgentFixture } from '../helpers/lineage.js';

/**
 * Why steps are keyed by instance rather than by node.
 *
 * A single node in the process graph can run many times in one execution: once per line item, once
 * per retry, once per branch of a fan-out. Keying a step by `node_id` would force all of those into
 * one row and the timeline would show one "Extract" that somehow took eleven attempts. Keying by
 * `(execution_id, step_instance_key, attempt_no)` gives every occurrence its own row, so eleven
 * parallel extractions are eleven rows and a retry of one of them is a twelfth.
 *
 * `sequence_no` is deliberately *not* unique. Parallel siblings share an ordinal because they are
 * genuinely simultaneous, and a unique ordinal would force the display to invent an order that the
 * execution never had.
 */

let owner: string;
let agent: AgentFixture;
let executionId: string;

async function insertStep(overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    execution_id: executionId,
    node_id: null,
    step_key: 'extract',
    step_instance_key: 'extract:line:1',
    sequence_no: 2,
    attempt_no: 1,
    status: 'running',
    started_at: new Date().toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  const { rows } = await asPostgres(async (client) =>
    client.query<{ step_execution_id: string }>(
      `insert into public.execution_steps (${columns.join(', ')})
       values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
       returning step_execution_id`,
      columns.map((column) => {
        const value = row[column];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      }),
    ),
  );
  return rows[0]?.step_execution_id as string;
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
  executionId = (await seedExecutionWithStep(agent)).executionId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('parallel step instances', () => {
  it('gives every fan-out branch its own row at the same ordinal', async () => {
    for (let line = 1; line <= 11; line += 1) {
      await insertStep({ step_instance_key: `extract:line:${String(line)}`, sequence_no: 2 });
    }
    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string; ordinals: string }>(
        `select count(*) as count, count(distinct sequence_no) as ordinals
           from public.execution_steps where execution_id = $1 and step_key = 'extract'`,
        [executionId],
      ),
    );
    expect(rows[0]?.count).toBe('11');
    expect(rows[0]?.ordinals).toBe('1');
  });

  it('refuses a second row for the same instance and attempt', async () => {
    await insertStep();
    await expectPgError(insertStep(), 'uq_execution_steps_instance_attempt');
  });

  it('records a retry as a new attempt rather than by editing the first', async () => {
    const first = await insertStep({
      status: 'failed',
      error_json: JSON.stringify({ code: 'EXTRACTION_TIMEOUT' }),
      completed_at: new Date().toISOString(),
    });
    const second = await insertStep({ attempt_no: 2 });
    expect(second).not.toBe(first);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ attempt_no: number; status: string }>(
        `select attempt_no, status from public.execution_steps
          where execution_id = $1 and step_instance_key = 'extract:line:1' order by attempt_no`,
        [executionId],
      ),
    );
    // Both attempts remain visible. Overwriting the first would hide the fact that the step ever
    // failed, and "it worked" is a different claim from "it worked on the second try".
    expect(rows).toEqual([
      { attempt_no: 1, status: 'failed' },
      { attempt_no: 2, status: 'running' },
    ]);
  });

  it('lets the same instance key appear in a different execution', async () => {
    const other = await seedExecutionWithStep(agent, { businessKey: 'MSKU7654321' });
    await insertStep();
    await expect(insertStep({ execution_id: other.executionId })).resolves.toBeTypeOf('string');
  });

  it('requires a failed step to say why it failed', async () => {
    await expectPgError(
      insertStep({ status: 'failed', completed_at: new Date().toISOString() }),
      'ck_execution_steps_failed_has_error',
    );
  });

  it('ties a terminal status to a completion time in both directions', async () => {
    await expectPgError(
      insertStep({ status: 'succeeded' }),
      'ck_execution_steps_completed_pairing',
    );
    await expectPgError(
      insertStep({ status: 'running', completed_at: new Date().toISOString() }),
      'ck_execution_steps_completed_pairing',
    );
  });

  it('requires a step that is past the queue to have a start time', async () => {
    await expectPgError(
      insertStep({ status: 'running', started_at: null }),
      'ck_execution_steps_started_pairing',
    );
    // A skipped step never ran, so it has neither a start nor a contradiction.
    await expect(
      insertStep({
        status: 'skipped',
        started_at: null,
        completed_at: new Date().toISOString(),
      }),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses an empty instance key', async () => {
    await expectPgError(
      insertStep({ step_instance_key: '   ' }),
      'ck_execution_steps_keys_nonempty',
    );
  });

  it('follows the declared status transitions', async () => {
    const stepId = await insertStep({ status: 'queued', started_at: null });
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.execution_steps set status = 'succeeded', completed_at = now()
            where step_execution_id = $1`,
          [stepId],
        ),
      ),
      'ILLEGAL_TRANSITION',
    );
  });

  it('keeps a step inside the execution that owns it', async () => {
    const other = await seedExecutionWithStep(agent, { businessKey: 'MSKU9999995' });
    const stepId = await insertStep();
    // The composite key `(step_execution_id, execution_id)` is what other tables reference, so a
    // step that could migrate between executions would drag its evidence with it.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.execution_steps set execution_id = $1 where step_execution_id = $2',
          [other.executionId, stepId],
        ),
      ),
      'STEP_IDENTITY_IMMUTABLE',
    );
  });
});
