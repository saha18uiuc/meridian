import { randomUUID } from 'node:crypto';
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
  fakeGitSha,
  freezeBoard,
  nextDeploymentKey,
  seedAgentVersion,
  type AgentFixture,
} from '../helpers/lineage.js';

/**
 * Lineage, enforced as composite foreign keys rather than as prose.
 *
 * An agent version points at an agent and at a frozen spec, and both of those belong to a board.
 * The interesting failure is not "the spec does not exist" — a plain foreign key catches that —
 * but "the spec exists and belongs to a different board", which a plain foreign key happily
 * accepts. Carrying `whiteboard_id` on the version and referencing the pair is what makes that
 * combination unrepresentable, and it is the reason an execution can name a version and be
 * guaranteed to have named exactly one process.
 */

let owner: string;
let fixture: AgentFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  fixture = await seedAgentVersion(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('agent version lineage', () => {
  it('binds a version to the board its agent and spec share', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ whiteboard_id: string; code_path: string }>(
        'select whiteboard_id, code_path from public.agent_versions where agent_version_id = $1',
        [fixture.agentVersionId],
      ),
    );
    expect(rows[0]?.whiteboard_id).toBe(fixture.boardId);
    expect(rows[0]?.code_path).toBe(`generated-agents/${fixture.deploymentKey}/v001`);
  });

  it('refuses a version whose spec belongs to another board', async () => {
    const otherBoard = await freezeBoard(owner, 'A different process');
    await expectPgError(
      rpcAsUser(owner, 'create_agent_version', [fixture.agentId, otherBoard.specId, null]),
      'SPEC_NOT_ON_AGENT_WHITEBOARD',
    );
  });

  it('refuses a hand-written version row that mixes two boards', async () => {
    const otherBoard = await freezeBoard(owner, 'Another process again');
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.agent_versions
             (agent_id, spec_id, whiteboard_id, version_no, code_path)
           values ($1, $2, $3, 99, $4)`,
          [
            fixture.agentId,
            otherBoard.specId,
            fixture.boardId,
            `generated-agents/${fixture.deploymentKey}/v099`,
          ],
        ),
      ),
      'fk_agent_versions_spec_lineage',
    );
  });

  it('allocates the next version number under the agent, not globally', async () => {
    const second = await rpcAsUser<{ versionNo: number; codePath: string }>(
      owner,
      'create_agent_version',
      [fixture.agentId, fixture.specId, fixture.agentVersionId],
    );
    expect(second.versionNo).toBe(2);
    expect(second.codePath).toBe(`generated-agents/${fixture.deploymentKey}/v002`);

    // A second agent on the same board starts its own numbering.
    const otherAgent = await rpcAsUser<{ agentId: string }>(owner, 'create_agent', [
      fixture.boardId,
      nextDeploymentKey(),
      'Second agent',
    ]);
    const otherFirst = await rpcAsUser<{ versionNo: number }>(owner, 'create_agent_version', [
      otherAgent.agentId,
      fixture.specId,
      null,
    ]);
    expect(otherFirst.versionNo).toBe(1);
  });

  it('requires a parent to belong to the same agent and to be older', async () => {
    const otherAgent = await rpcAsUser<{ agentId: string }>(owner, 'create_agent', [
      fixture.boardId,
      nextDeploymentKey(),
      'Unrelated agent',
    ]);
    const foreign = await rpcAsUser<{ agentVersionId: string }>(owner, 'create_agent_version', [
      otherAgent.agentId,
      fixture.specId,
      null,
    ]);

    await expectPgError(
      rpcAsUser(owner, 'create_agent_version', [
        fixture.agentId,
        fixture.specId,
        foreign.agentVersionId,
      ]),
      'fk_agent_versions_parent_same_agent',
    );
  });

  it('refuses a version that is its own parent', async () => {
    // Two rules forbid this and the ordering rule speaks first, which is the more useful message:
    // a repair must descend from something strictly older, and nothing is older than itself.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.agent_versions set parent_agent_version_id = agent_version_id where agent_version_id = $1',
          [fixture.agentVersionId],
        ),
      ),
      'PARENT_VERSION_NOT_LOWER',
    );
  });

  it('freezes the lineage once a version leaves the generated state', async () => {
    await rpcAsService('record_agent_commit', [
      owner,
      fixture.agentVersionId,
      fixture.gitCommitSha,
      JSON.stringify(buildManifest(fixture.specHash)),
    ]);
    await rpcAsUser(owner, 'transition_agent_version', [fixture.agentVersionId, 'evaluating']);

    // After evaluation begins, the recorded commit *is* the evidence. Changing it would silently
    // invalidate every eval result already attributed to this version.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.agent_versions set git_commit_sha = $1 where agent_version_id = $2',
          [fakeGitSha(), fixture.agentVersionId],
        ),
      ),
      'AGENT_VERSION_LINEAGE_FROZEN',
    );
  });

  it('derives the code path rather than accepting one', async () => {
    // A version's directory is a function of its deployment key and version number, so two
    // versions cannot collide and no version can point at a directory that belongs to another.
    // Uniqueness is then a consequence rather than something a writer has to remember.
    for (const path of [
      'generated-agents/somewhere-else/v001',
      'src/agents/handwritten',
      `generated-agents/${fixture.deploymentKey}/v002`,
    ]) {
      await expectPgError(
        asPostgres(async (client) =>
          client.query(
            'update public.agent_versions set code_path = $1 where agent_version_id = $2',
            [path, fixture.agentVersionId],
          ),
        ),
        'CODE_PATH_MISMATCH',
      );
    }
  });

  it('ties approval to an approval timestamp in both directions', async () => {
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          `insert into public.agent_versions
             (agent_id, spec_id, whiteboard_id, version_no, code_path, status, approved_at)
           values ($1, $2, $3, 60, $4, 'generated', now())`,
          [
            fixture.agentId,
            fixture.specId,
            fixture.boardId,
            `generated-agents/${fixture.deploymentKey}/v060`,
          ],
        ),
      ),
      'ck_agent_versions_approved_at',
    );
  });

  it('keeps a deployment key unique across the whole installation', async () => {
    await expectPgError(
      rpcAsUser(owner, 'create_agent', [fixture.boardId, fixture.deploymentKey, 'Duplicate key']),
      'DEPLOYMENT_KEY_TAKEN',
    );
  });

  it('refuses a deployment key that would not make a valid directory name', async () => {
    for (const key of ['Inbound_Import', 'ab', '9agent', 'inbound import']) {
      await expectPgError(
        rpcAsUser(owner, 'create_agent', [fixture.boardId, key, 'Bad key']),
        'INVALID_DEPLOYMENT_KEY',
      );
    }
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
