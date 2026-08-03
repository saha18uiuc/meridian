import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/hashing.js';
import {
  asPostgres,
  asService,
  asUser,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  truncateAll,
} from '../helpers/db.js';
import {
  seedActiveAgent,
  seedExecutionWithStep,
  type AgentFixture,
  type ExecutionFixture,
} from '../helpers/lineage.js';

/**
 * The event log is the evidence, so it is append-only in the database rather than by convention.
 *
 * An audit trail that can be edited is not an audit trail. `update` and `delete` are revoked from
 * every application role *and* rejected by a trigger, which matters because a revoke alone would
 * still leave the table editable by anything running as owner — including a future migration or a
 * well-meant repair script. The trigger closes that door.
 *
 * The second guarantee is that an event cannot lie about where it belongs: a step referenced by an
 * event must be a step of the same execution, enforced by a composite key rather than by the
 * writer remembering to pass matching ids.
 */

let owner: string;
let agent: AgentFixture;
let execution: ExecutionFixture;

async function insertEvent(overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    execution_id: execution.executionId,
    step_execution_id: execution.stepExecutionId,
    event_type: 'evidence',
    event_key: 'extraction',
    payload_json: { containerNumber: 'MSKU1234565' },
    ...overrides,
  };
  const columns = Object.keys(row);
  const { rows } = await asService(async (client) =>
    client.query<{ event_id: string }>(
      `insert into public.execution_events (${columns.join(', ')})
       values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
       returning event_id`,
      columns.map((column) => {
        const value = row[column];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      }),
    ),
  );
  return rows[0]?.event_id as string;
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
  execution = await seedExecutionWithStep(agent);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('execution events', () => {
  it('accepts appends from the service role', async () => {
    const eventId = await insertEvent();
    expect(eventId).toBeDefined();
  });

  it('refuses an update even from the table owner', async () => {
    const eventId = await insertEvent();
    // As superuser, so this is not testing the grant. A privileged repair script is exactly the
    // thing an append-only guarantee has to survive.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `update public.execution_events set payload_json = '{}'::jsonb where event_id = $1`,
          [eventId],
        ),
      ),
      'IMMUTABLE_ROW',
    );
  });

  it('refuses a delete even from the table owner', async () => {
    const eventId = await insertEvent();
    await expectPgError(
      asPostgres(async (client) =>
        client.query('delete from public.execution_events where event_id = $1', [eventId]),
      ),
      'IMMUTABLE_ROW',
    );
  });

  it('has no update or delete grant for any application role', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'execution_events'
            and privilege_type in ('UPDATE','DELETE')
            and grantee in ('anon','authenticated','service_role')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('refuses an event whose step belongs to another execution', async () => {
    const other = await seedExecutionWithStep(agent, { businessKey: 'MSKU7654321' });
    await expectPgError(
      insertEvent({ step_execution_id: other.stepExecutionId }),
      'fk_execution_events_step',
    );
  });

  it('requires an action event to name the action it describes', async () => {
    await expectPgError(
      insertEvent({ event_type: 'action', execution_action_id: null }),
      'ck_execution_events_action_has_action_id',
    );
  });

  it('refuses an event type outside the four the reader understands', async () => {
    await expectPgError(insertEvent({ event_type: 'human_decision' }), 'ck_execution_events_type');
  });

  it('collapses a retried append onto one row through its idempotency key', async () => {
    // Workers retry. Without this, one delivered email would appear twice in the evidence and a
    // reader counting events would conclude it was sent twice.
    const key = sha256Hex(`${execution.executionId}|extraction`);
    await insertEvent({ idempotency_key: key });
    await expectPgError(insertEvent({ idempotency_key: key }), 'uq_execution_events_idem');
  });

  it('allows many events with no idempotency key at all', async () => {
    await insertEvent({ event_key: 'note-1' });
    await insertEvent({ event_key: 'note-2' });
    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        'select count(*) as count from public.execution_events where execution_id = $1',
        [execution.executionId],
      ),
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(2);
  });

  it('preserves append order under a monotonic identity', async () => {
    const first = await insertEvent({ event_key: 'a' });
    const second = await insertEvent({ event_key: 'b' });
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
  });

  it('lets the board owner read its events and nobody else', async () => {
    await insertEvent();
    const [stranger] = (await createTestUsers(1)) as [string];

    const mine = await asUser(owner, async (client) =>
      client.query('select event_id from public.execution_events'),
    );
    expect(mine.rowCount).toBeGreaterThan(0);

    const theirs = await asUser(stranger, async (client) =>
      client.query('select event_id from public.execution_events'),
    );
    expect(theirs.rowCount).toBe(0);
  });

  it('pins a step in place once evidence refers to it', async () => {
    const eventId = await insertEvent();
    // The foreign key would null the link on delete, but nulling it is a mutation of the log and
    // immutability wins. The consequence is the one worth having: a step that produced evidence
    // cannot be made to disappear, so no event is ever left pointing at nothing.
    await expectPgError(
      asPostgres(async (client) =>
        client.query('delete from public.execution_steps where step_execution_id = $1', [
          execution.stepExecutionId,
        ]),
      ),
      'IMMUTABLE_ROW',
    );
    const { rows } = await asPostgres(async (client) =>
      client.query<{ step_execution_id: string | null }>(
        'select step_execution_id from public.execution_events where event_id = $1',
        [eventId],
      ),
    );
    expect(rows[0]?.step_execution_id).toBe(execution.stepExecutionId);
  });

  it('is what the execution RPCs actually write to', async () => {
    await rpcAsService('complete_execution', [
      execution.executionId,
      'passed',
      JSON.stringify({ outcome: 'ready_for_entry' }),
      JSON.stringify({}),
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ event_type: string; event_key: string | null }>(
        `select event_type, event_key from public.execution_events
          where execution_id = $1 order by event_id`,
        [execution.executionId],
      ),
    );
    expect(rows.map((row) => row.event_type)).toContain('state_transition');
    expect(randomUUID()).toBeTypeOf('string');
  });
});
