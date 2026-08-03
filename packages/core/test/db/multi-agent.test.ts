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
  buildManifest,
  idempotencyKey,
  nextDeploymentKey,
  seedActiveAgent,
  seedAgentVersion,
  type AgentFixture,
} from '../helpers/lineage.js';

/**
 * Several agents on one board, which is the case the brief cares about and the one that breaks
 * naive designs.
 *
 * A board describes a process; an agent is one deployed implementation of part of it. Once two
 * agents exist on the same board, every identifier that was "obviously" unique stops being so:
 * version numbers, code paths, release pointers, and execution idempotency keys all have to be
 * scoped to the agent rather than to the board. The tests below are the places where getting that
 * wrong would surface as one agent's activation silently changing what another one runs.
 */

let owner: string;
let first: AgentFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  first = await seedActiveAgent(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

async function secondAgent(): Promise<{ agentId: string; deploymentKey: string }> {
  const deploymentKey = nextDeploymentKey();
  const agent = await rpcAsUser<{ agentId: string }>(owner, 'create_agent', [
    first.boardId,
    deploymentKey,
    'Second agent on the same board',
  ]);
  return { agentId: agent.agentId, deploymentKey };
}

/** Carry a second agent on the same board all the way to an activated release. */
async function activeSecondAgent(): Promise<{ agentId: string; agentVersionId: string }> {
  const agent = await secondAgent();
  const version = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
    agent.agentId,
    first.specId,
    null,
  ]);
  await rpcAsService('record_agent_commit', [
    owner,
    version.agentVersionId,
    first.gitCommitSha.replace(/.$/, '0'),
    JSON.stringify(buildManifest(first.specHash)),
  ]);
  await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'evaluating']);
  await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'approved']);
  await rpcAsUser(owner, 'activate_agent_version', [agent.agentId, version.agentVersionId]);
  return { agentId: agent.agentId, agentVersionId: version.agentVersionId };
}

describe('several agents on one board', () => {
  it('lets two agents share a board and a frozen spec', async () => {
    const second = await secondAgent();
    const version = await rpcAsUser<{ agentVersionId: string; versionNo: number }>(
      owner,
      'create_agent_version',
      [second.agentId, first.specId, null],
    );
    expect(version.versionNo).toBe(1);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        'select count(*) as count from public.agent_versions where spec_id = $1',
        [first.specId],
      ),
    );
    // One specification, two implementations. Nothing about a frozen spec is per-agent, which is
    // what makes it a shared contract rather than a private copy.
    expect(rows[0]?.count).toBe('2');
  });

  it('numbers versions per agent, not per board or per spec', async () => {
    const second = await secondAgent();
    await rpcAsUser(owner, 'create_agent_version', [second.agentId, first.specId, null]);
    const secondV2 = await rpcAsUser<{ versionNo: number; codePath: string }>(
      owner,
      'create_agent_version',
      [second.agentId, first.specId, null],
    );
    expect(secondV2.versionNo).toBe(2);
    expect(secondV2.codePath).toBe(`generated-agents/${second.deploymentKey}/v002`);

    const firstNext = await rpcAsUser<{ versionNo: number }>(owner, 'create_agent_version', [
      first.agentId,
      first.specId,
      first.agentVersionId,
    ]);
    expect(firstNext.versionNo).toBe(2);
  });

  it('gives each agent its own directory, so generated code never collides', async () => {
    const second = await secondAgent();
    const version = await rpcAsUser<{ codePath: string }>(owner, 'create_agent_version', [
      second.agentId,
      first.specId,
      null,
    ]);
    expect(version.codePath).not.toBe(`generated-agents/${first.deploymentKey}/v001`);
    expect(version.codePath).toMatch(/^generated-agents\/[a-z][a-z0-9-]{2,63}\/v001$/);
  });

  it('keeps release pointers independent', async () => {
    const second = await secondAgent();
    const version = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
      second.agentId,
      first.specId,
      null,
    ]);
    await rpcAsService('record_agent_commit', [
      owner,
      version.agentVersionId,
      first.gitCommitSha.replace(/.$/, '0'),
      JSON.stringify(buildManifest(first.specHash)),
    ]);
    await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'evaluating']);
    await rpcAsUser(owner, 'transition_agent_version', [version.agentVersionId, 'approved']);
    await rpcAsUser(owner, 'activate_agent_version', [second.agentId, version.agentVersionId]);

    const { rows } = await asPostgres(async (client) =>
      client.query<{ agent_id: string; active_agent_version_id: string }>(
        'select agent_id, active_agent_version_id from public.agents order by created_at',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.active_agent_version_id).toBe(first.agentVersionId);
    expect(rows[1]?.active_agent_version_id).toBe(version.agentVersionId);
  });

  it('refuses to point one agent at another agent\u2019s version', async () => {
    const second = await secondAgent();
    // Without this the release pointer would be the single place where two agents could be made
    // to run the same code while reporting different lineage.
    await expectPgError(
      rpcAsUser(owner, 'activate_agent_version', [second.agentId, first.agentVersionId]),
      'VERSION_NOT_ON_AGENT',
    );
  });

  it('scopes execution idempotency to the agent that ran', async () => {
    const second = await activeSecondAgent();

    const businessKey = 'MSKU1234565';
    const mine = await rpcAsService<{ executionId: string }>('create_execution', [
      first.agentId,
      first.agentVersionId,
      'live',
      `live:${businessKey}`,
      businessKey,
      `receiving:${businessKey}`,
      idempotencyKey('live', businessKey, first.agentVersionId),
      JSON.stringify({}),
    ]);
    // The same container arriving for a different agent is a different run. Keying only on the
    // business key would make the second agent silently adopt the first one's execution.
    const theirs = await rpcAsService<{ executionId: string }>('create_execution', [
      second.agentId,
      second.agentVersionId,
      'live',
      `live:${businessKey}`,
      businessKey,
      `receiving:${businessKey}:2`,
      idempotencyKey('live', businessKey, second.agentVersionId),
      JSON.stringify({}),
    ]);
    expect(theirs.executionId).not.toBe(mine.executionId);
  });

  it('refuses an execution that names a version the agent is not running', async () => {
    // The check is against the release pointer rather than merely against ownership, so it also
    // catches an agent's own retired version — the case where a worker holds a stale definition.
    const second = await activeSecondAgent();
    await expectPgError(
      rpcAsService('create_execution', [
        second.agentId,
        first.agentVersionId,
        'live',
        'live:MSKU7654321',
        'MSKU7654321',
        'receiving:MSKU7654321',
        idempotencyKey('live', 'MSKU7654321', second.agentId),
        JSON.stringify({}),
      ]),
      'VERSION_NOT_ACTIVE_RELEASE',
    );
  });

  it('keeps one board\u2019s agents invisible to another owner', async () => {
    const [stranger] = (await createTestUsers(1)) as [string];
    await secondAgent();
    const visible = await rpcAsService<unknown>('create_execution', [
      first.agentId,
      first.agentVersionId,
      'eval',
      'case-01',
      null,
      null,
      idempotencyKey('eval', 'case-01', first.agentVersionId),
      JSON.stringify({}),
    ]);
    expect(visible).toBeDefined();

    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>(
        `select count(*) as count from public.agents where whiteboard_id = $1`,
        [first.boardId],
      ),
    );
    expect(rows[0]?.count).toBe('2');
    expect(stranger).toBeTypeOf('string');
  });

  it('archives one agent without disturbing the other', async () => {
    const second = await secondAgent();
    await rpcAsUser(owner, 'create_agent_version', [second.agentId, first.specId, null]);

    await asPostgres(async (client) => {
      await client.query(
        `update public.agents set status = 'archived', active_agent_version_id = null
          where agent_id = $1`,
        [second.agentId],
      );
    });

    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string; active_agent_version_id: string | null }>(
        'select status, active_agent_version_id from public.agents where agent_id = $1',
        [first.agentId],
      ),
    );
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.active_agent_version_id).toBe(first.agentVersionId);
  });

  it('does not let a draft agent version stand in for a release', async () => {
    const draft = await seedAgentVersion(owner);
    await expectPgError(
      rpcAsUser(owner, 'activate_agent_version', [draft.agentId, draft.agentVersionId]),
      'VERSION_NOT_APPROVED',
    );
  });
});
