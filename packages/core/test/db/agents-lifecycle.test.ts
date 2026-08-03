import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';
import { freezeBoard, nextDeploymentKey } from '../helpers/lineage.js';

/**
 * The logical agent (A7) is the stable identity a deployment key points at; versions come and go
 * underneath it. These cases pin down what the database will and will not accept for that row.
 */

let owner: string;
let boardId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  boardId = (await freezeBoard(owner)).boardId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

const createAgent = (key: string, name = 'Inbound receiving'): Promise<{ agentId: string }> =>
  rpcAsUser<{ agentId: string }>(owner, 'create_agent', [boardId, key, name]);

describe('create_agent', () => {
  it('creates a draft agent with no release pointer', async () => {
    const key = nextDeploymentKey();
    const agent = await createAgent(key);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string; active_agent_version_id: string | null }>(
        'select status, active_agent_version_id from public.agents where agent_id = $1',
        [agent.agentId],
      ),
    );
    expect(rows[0]).toMatchObject({ status: 'draft', active_agent_version_id: null });
  });

  it('lower-cases and trims the deployment key', async () => {
    const key = nextDeploymentKey();
    const result = await rpcAsUser<{ deploymentKey: string }>(owner, 'create_agent', [
      boardId,
      `  ${key.toUpperCase()}  `,
      'Agent',
    ]);
    expect(result.deploymentKey).toBe(key);
  });

  it('rejects a key that does not match the slug shape', async () => {
    await expectPgError(createAgent('Not A Slug'), 'INVALID_DEPLOYMENT_KEY');
    await expectPgError(createAgent('ab'), 'INVALID_DEPLOYMENT_KEY');
    await expectPgError(createAgent('9leading-digit'), 'INVALID_DEPLOYMENT_KEY');
  });

  it('rejects a blank name', async () => {
    await expectPgError(createAgent(nextDeploymentKey(), '   '), 'INVALID_AGENT_NAME');
  });

  it('rejects a deployment key that is already taken, globally', async () => {
    const key = nextDeploymentKey();
    await createAgent(key);
    // Global rather than per-board on purpose: the key is what the worker routes on, so two
    // boards claiming the same key would make routing ambiguous.
    await expectPgError(createAgent(key), 'DEPLOYMENT_KEY_TAKEN');
  });

  it('refuses to create an agent on somebody else’s board', async () => {
    const [other] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsUser(other, 'create_agent', [boardId, nextDeploymentKey(), 'Stolen']),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });
});

describe('the agents table invariants', () => {
  it('will not let an agent be active without a version pointer', async () => {
    const agent = await createAgent(nextDeploymentKey());
    await expectPgError(
      asPostgres(async (client) =>
        client.query("update public.agents set status = 'active' where agent_id = $1", [
          agent.agentId,
        ]),
      ),
      'ck_agents_active_requires_version',
    );
  });

  it('will not let an archived agent keep a version pointer', async () => {
    const agent = await createAgent(nextDeploymentKey());
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          "update public.agents set status = 'archived', active_agent_version_id = $2 where agent_id = $1",
          [agent.agentId, agent.agentId],
        ),
      ),
      'ck_agents_archived_has_no_pointer',
    );
  });
});
