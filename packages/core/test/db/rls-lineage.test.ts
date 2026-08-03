import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_TABLES,
  asAnon,
  asPostgres,
  asUser,
  closePool,
  createTestUsers,
  rpcAsService,
  truncateAll,
} from '../helpers/db.js';
import {
  idempotencyKey,
  seedActiveAgent,
  seedExecutionWithStep,
  type AgentFixture,
} from '../helpers/lineage.js';
import { reviewRound } from '../helpers/review.js';

/**
 * Visibility follows lineage all the way down, and there is exactly one root.
 *
 * Every table in the application reaches `whiteboards.owner_id` by a chain of joins, so the answer
 * to "who may see this execution event" is derived from who owns the board the agent was generated
 * from. There is no per-table notion of ownership to keep in sync, which is the point: a second
 * definition of ownership is a second thing that can disagree.
 *
 * The other half is that no browser role can write anywhere. Reads are policy-governed and writes
 * go through `SECURITY DEFINER` RPCs, so there is no table a client can reach directly. This is
 * asserted by inspecting the grants rather than by trying every statement, because a missing
 * policy and a missing grant fail identically at runtime and only one of them is the guarantee.
 */

const LINEAGE_TABLES = [
  'whiteboards',
  'whiteboard_nodes',
  'whiteboard_edges',
  'review_sessions',
  'comments',
  'frozen_specs',
  'agents',
  'agent_versions',
  'executions',
  'execution_steps',
  'execution_events',
  'execution_actions',
] as const;

let mine: string;
let theirs: string;
let myAgent: AgentFixture;

beforeAll(async () => {
  await truncateAll();
  [mine, theirs] = (await createTestUsers(2)) as [string, string];
  myAgent = await seedActiveAgent(mine);
  // Every table needs at least one row of mine, or "the owner can see it" would be vacuous.
  await reviewRound(mine, myAgent.boardId, [
    {
      issueKey: 'det:missing_owner:node:action:1',
      severity: 'blocking',
      body: 'No owner is named for this action.',
      anchorType: 'canvas',
      anchorId: null,
    },
  ]);
  const execution = await seedExecutionWithStep(myAgent);
  await asPostgres(async (client) => {
    await client.query(
      `insert into public.execution_events (execution_id, step_execution_id, event_type, payload_json)
       values ($1, $2, 'evidence', '{"containerNumber":"MSKU1234565"}'::jsonb)`,
      [execution.executionId, execution.stepExecutionId],
    );
  });
  await rpcAsService('reserve_execution_action', [
    execution.executionId,
    execution.stepExecutionId,
    'mail.send',
    JSON.stringify({ to: 'ops@example.com' }),
    idempotencyKey('mail.send', execution.executionId),
  ]);
  // A second owner with their own full chain, so "sees nothing" is distinguishable from
  // "there was nothing to see".
  await seedActiveAgent(theirs);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

async function countAs(userId: string, table: string): Promise<number> {
  return asUser(userId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `select count(*) as count from public.${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });
}

describe('row-level security follows lineage', () => {
  it('shows an owner every row that descends from their board', async () => {
    for (const table of LINEAGE_TABLES) {
      expect(await countAs(mine, table), table).toBeGreaterThan(0);
    }
  });

  it('hides every one of those rows from another authenticated user', async () => {
    // Each table is asked for *my* rows specifically. The other owner has a full chain of their
    // own, so a plain row count would pass even if the policies did nothing.
    const mineOnly: Record<string, { sql: string; param: string }> = {
      whiteboards: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      whiteboard_nodes: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      whiteboard_edges: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      review_sessions: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      comments: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      frozen_specs: { sql: 'whiteboard_id = $1', param: myAgent.boardId },
      agents: { sql: 'agent_id = $1', param: myAgent.agentId },
      agent_versions: { sql: 'agent_id = $1', param: myAgent.agentId },
      executions: { sql: 'agent_id = $1', param: myAgent.agentId },
      execution_steps: {
        sql: 'execution_id in (select execution_id from public.executions where agent_id = $1)',
        param: myAgent.agentId,
      },
      execution_events: {
        sql: 'execution_id in (select execution_id from public.executions where agent_id = $1)',
        param: myAgent.agentId,
      },
      execution_actions: {
        sql: 'execution_id in (select execution_id from public.executions where agent_id = $1)',
        param: myAgent.agentId,
      },
    };

    for (const table of LINEAGE_TABLES) {
      const filter = mineOnly[table];
      if (filter === undefined) throw new Error(`no ownership filter declared for ${table}`);
      const visible = await asUser(theirs, async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) as count from public.${table} where ${filter.sql}`,
          [filter.param],
        );
        return Number(rows[0]?.count ?? 0);
      });
      expect(visible, table).toBe(0);
    }
  });

  it('refuses an anonymous visitor at the grant, before any policy is consulted', async () => {
    // `anon` has no select grant at all, so the refusal is a permission error rather than an empty
    // result. That ordering is worth pinning: a policy that was accidentally dropped would leak
    // rows, whereas a missing grant cannot.
    for (const table of LINEAGE_TABLES) {
      await expect(
        asAnon(async (client) => client.query(`select count(*) from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('has row-level security enabled on every application table', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      ),
    );
    expect(rows.map((row) => row.relname)).toEqual([]);
    expect(APPLICATION_TABLES.length).toBe(LINEAGE_TABLES.length);
  });

  it('grants no write anywhere to a browser role', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee in ('anon','authenticated')
            and privilege_type in ('INSERT','UPDATE','DELETE')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('defines no write policy anywhere for a browser role', async () => {
    // A grant and a policy are both required for a write to succeed, so this is redundant with the
    // test above — deliberately. A future migration that restores a grant should still find no
    // policy waiting for it.
    const { rows } = await asPostgres(async (client) =>
      client.query<{ tablename: string; policyname: string; cmd: string }>(
        `select tablename, policyname, cmd from pg_policies
          where schemaname = 'public' and cmd <> 'SELECT'`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('lets the service role read across owners, because it acts for the system', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        'select count(distinct owner_id) as count from public.whiteboards',
      ),
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });
});
