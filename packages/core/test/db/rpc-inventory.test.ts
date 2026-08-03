import { afterAll, describe, expect, it } from 'vitest';
import { closePool, pool, RPC_NAMES } from '../helpers/db.js';

/**
 * The RPC surface is the write path, so its shape is a contract rather than an implementation
 * detail. A function added to `public` without being added to this list is either a new privileged
 * entry point nobody reviewed, or a helper that belongs in the `meridian` schema instead.
 */

interface ProcRow {
  proname: string;
  security_definer: boolean;
  search_path: string | null;
  acl: string | null;
}

async function publicFunctions(): Promise<ProcRow[]> {
  const { rows } = await pool.query<ProcRow>(
    `select p.proname,
            p.prosecdef                                    as security_definer,
            (select c from unnest(coalesce(p.proconfig, '{}')) c
              where c like 'search_path=%' limit 1)        as search_path,
            array_to_string(p.proacl, ',')                 as acl
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by p.proname`,
  );
  return rows;
}

afterAll(async () => {
  await closePool();
});

describe('the public RPC inventory', () => {
  it('contains exactly the twenty-nine documented functions', async () => {
    const actual = (await publicFunctions()).map((row) => row.proname).sort();
    expect(RPC_NAMES).toHaveLength(29);
    expect(actual).toEqual([...RPC_NAMES].sort());
  });

  it('declares every one of them SECURITY DEFINER with a pinned search path', async () => {
    const offenders = (await publicFunctions())
      .filter((row) => !row.security_definer || row.search_path !== 'search_path=""')
      .map(
        (row) =>
          `${row.proname}: secdef=${String(row.security_definer)} ${row.search_path ?? 'none'}`,
      );
    // An empty `search_path` is what stops a caller-controlled schema from shadowing `public`
    // inside a definer function, which would otherwise be a privilege-escalation route.
    expect(offenders).toEqual([]);
  });

  it('revokes execute from anon on every function', async () => {
    const offenders = (await publicFunctions())
      .filter((row) => (row.acl ?? '').includes('anon='))
      .map((row) => row.proname);
    expect(offenders).toEqual([]);
  });

  it('restricts the service-role-only functions to the service role', async () => {
    // These six write authoritative artefacts — snapshots, hashes, frozen specs, policy gaps, and
    // Git lineage — so a browser session must not be able to call them even with a valid JWT.
    const serviceOnly = [
      'create_review_session',
      'finalize_review_session',
      'fail_review_session',
      'freeze_whiteboard_spec',
      'record_agent_commit',
      'record_policy_gap',
    ];
    const rows = await publicFunctions();
    for (const name of serviceOnly) {
      const row = rows.find((candidate) => candidate.proname === name);
      expect(row, name).toBeDefined();
      expect(row?.acl ?? '', name).toContain('service_role=');
      expect(row?.acl ?? '', name).not.toContain('authenticated=');
    }
  });

  it('keeps the execution and action functions off the authenticated role', async () => {
    const rows = await publicFunctions();
    const executionFunctions = rows.filter((row) =>
      /^(create_execution|start_execution|complete_execution|fail_execution|create_manual_review_intake_execution|reserve_execution_action|dispatch_execution_action|complete_execution_action|mark_execution_action_for_reconciliation|reconcile_execution_action|abandon_execution_action)$/.test(
        row.proname,
      ),
    );
    expect(executionFunctions).toHaveLength(11);
    for (const row of executionFunctions) {
      expect(row.acl ?? '', row.proname).not.toContain('authenticated=');
    }
  });
});

describe('helper functions', () => {
  it('live in the meridian schema, not in public', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'meridian'`,
    );
    // The split matters: `public` is the reviewed API surface and `meridian` is machinery.
    expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });
});
