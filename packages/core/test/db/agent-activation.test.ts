import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';
import {
  type AgentFixture,
  buildManifest,
  fakeGitSha,
  seedActiveAgent,
} from '../helpers/lineage.js';

/**
 * Activation is the release pointer, and rollback is the same operation aimed backwards (A17).
 *
 * Nothing is deleted by rolling back, and an execution keeps the `agent_version_id` it actually
 * ran, so the audit trail survives a rollback intact. That is the whole reason activation is a
 * pointer rather than a status on the version.
 */

let owner: string;
let fixture: AgentFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  fixture = await seedActiveAgent(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

/** Reserve, commit, and approve a second version on the same agent. */
async function approveNextVersion(): Promise<string> {
  const version = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
    fixture.agentId,
    fixture.specId,
    fixture.agentVersionId,
  ]);
  await rpcAsService('record_agent_commit', [
    owner,
    version.agentVersionId,
    fakeGitSha(),
    JSON.stringify(buildManifest(fixture.specHash)),
  ]);
  await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'evaluating']);
  await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'approved']);
  return version.agentVersionId;
}

async function pointer(): Promise<{ active_agent_version_id: string | null; status: string }> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{ active_agent_version_id: string | null; status: string }>(
      'select active_agent_version_id, status from public.agents where agent_id = $1',
      [fixture.agentId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('agent disappeared');
  return row;
}

describe('activate_agent_version', () => {
  it('points the agent at the approved version and marks it active', async () => {
    expect(await pointer()).toMatchObject({
      active_agent_version_id: fixture.agentVersionId,
      status: 'active',
    });
  });

  it('reports the previous pointer when it moves forward', async () => {
    const second = await approveNextVersion();
    const result = await rpcAsUser<{ previousActiveAgentVersionId: string | null }>(
      owner,
      'activate_agent_version',
      [fixture.agentId, second],
    );
    expect(result.previousActiveAgentVersionId).toBe(fixture.agentVersionId);
  });

  it('rolls back to an earlier approved version without destroying the newer one', async () => {
    const second = await approveNextVersion();
    await rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, second]);
    await rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, fixture.agentVersionId]);

    expect((await pointer()).active_agent_version_id).toBe(fixture.agentVersionId);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string }>(
        'select status from public.agent_versions where agent_version_id = $1',
        [second],
      ),
    );
    expect(rows[0]?.status).toBe('approved');
  });

  it('refuses to activate a version that is not approved', async () => {
    const reserved = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
      fixture.agentId,
      fixture.specId,
      fixture.agentVersionId,
    ]);
    await expectPgError(
      rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, reserved.agentVersionId]),
      'ACTIVE_VERSION_NOT_APPROVED',
    );
  });

  it('refuses to activate a version belonging to a different agent', async () => {
    const otherAgent = await seedActiveAgent(owner);
    await expectPgError(
      rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, otherAgent.agentVersionId]),
      'VERSION_NOT_ON_AGENT',
    );
  });

  it('refuses to activate on an archived agent', async () => {
    await asPostgres(async (client) =>
      client.query(
        "update public.agents set status = 'archived', active_agent_version_id = null where agent_id = $1",
        [fixture.agentId],
      ),
    );
    await expectPgError(
      rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, fixture.agentVersionId]),
      'AGENT_ARCHIVED',
    );
  });

  it('is not callable by the service role', async () => {
    // Activation is an operator decision about production traffic, so it stays on the
    // authenticated role even though almost everything else here is service-role only.
    await expectPgError(
      rpcAsService('activate_agent_version', [fixture.agentId, fixture.agentVersionId]),
      'permission denied',
    );
  });

  it('is invisible to another user', async () => {
    const [other] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsUser(other, 'activate_agent_version', [fixture.agentId, fixture.agentVersionId]),
      'AGENT_NOT_FOUND_OR_FORBIDDEN',
    );
  });
});
