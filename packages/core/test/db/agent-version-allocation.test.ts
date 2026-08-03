import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  openSession,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';
import { freezeBoard, nextDeploymentKey } from '../helpers/lineage.js';

/**
 * Version numbers are allocated under the agent's row lock, not by a sequence.
 *
 * A sequence would leave gaps whenever a reservation was rolled back, and `code_path` embeds the
 * number, so a gap would show up as a missing folder that nobody could explain. Taking the lock
 * makes `max(version_no) + 1` safe under concurrency at the cost of serialising reservations for
 * one agent, which is a trade worth making for an operation that happens a handful of times a day.
 */

let owner: string;
let agentId: string;
let specId: string;
let boardId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const frozen = await freezeBoard(owner);
  boardId = frozen.boardId;
  specId = frozen.specId;
  const agent = await rpcAsUser<{ agentId: string }>(owner, 'create_agent', [
    boardId,
    nextDeploymentKey(),
    'Agent',
  ]);
  agentId = agent.agentId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

const reserve = (parent: string | null = null) =>
  rpcAsUser<{ agentVersionId: string; versionNo: number; codePath: string; specHash: string }>(
    owner,
    'create_agent_version',
    [agentId, specId, parent],
  );

describe('create_agent_version', () => {
  it('reserves v001 with a derived code path and the spec hash in the manifest', async () => {
    const version = await reserve();
    expect(version.versionNo).toBe(1);
    expect(version.codePath).toMatch(/^generated-agents\/[a-z][a-z0-9-]{2,63}\/v001$/);

    const { rows } = await asPostgres(async (client) =>
      client.query<{
        status: string;
        git_commit_sha: string | null;
        build_manifest_json: Record<string, unknown>;
      }>(
        'select status, git_commit_sha, build_manifest_json from public.agent_versions where agent_version_id = $1',
        [version.agentVersionId],
      ),
    );
    expect(rows[0]).toMatchObject({ status: 'generated', git_commit_sha: null });
    expect(rows[0]?.build_manifest_json).toMatchObject({
      state: 'reserved',
      specHash: version.specHash,
    });
  });

  it('allocates ten sequential numbers with no gaps', async () => {
    const numbers: number[] = [];
    for (let index = 0; index < 10; index += 1) numbers.push((await reserve()).versionNo);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('serializes two concurrent reservations onto distinct numbers', async () => {
    // Two real connections and an interleaved commit: if the allocation were not under the agent
    // lock, both would read max=0 and both would try to insert version 1.
    const first = await openSession('authenticated', owner);
    const second = await openSession('authenticated', owner);
    try {
      await first.client.query('select public.create_agent_version($1,$2,null)', [agentId, specId]);
      const pending = second.client.query<{ result: { versionNo: number } }>(
        'select public.create_agent_version($1,$2,null) as result',
        [agentId, specId],
      );
      await first.client.query('commit');
      const { rows } = await pending;
      await second.client.query('commit');
      expect(rows[0]?.result.versionNo).toBe(2);
    } finally {
      first.release();
      second.release();
    }
  });

  it('records the parent when a repair version is reserved', async () => {
    const parent = await reserve();
    const child = await reserve(parent.agentVersionId);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ parent_agent_version_id: string | null }>(
        'select parent_agent_version_id from public.agent_versions where agent_version_id = $1',
        [child.agentVersionId],
      ),
    );
    expect(rows[0]?.parent_agent_version_id).toBe(parent.agentVersionId);
  });

  it('refuses a spec that belongs to a different board', async () => {
    const otherBoard = await freezeBoard(owner, 'Another board');
    await expectPgError(
      rpcAsUser(owner, 'create_agent_version', [agentId, otherBoard.specId, null]),
      'SPEC_NOT_ON_AGENT_WHITEBOARD',
    );
  });

  it('refuses to reserve against an archived agent', async () => {
    await asPostgres(async (client) =>
      client.query("update public.agents set status = 'archived' where agent_id = $1", [agentId]),
    );
    await expectPgError(reserve(), 'AGENT_ARCHIVED');
  });

  it('is invisible to another user', async () => {
    const [other] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsUser(other, 'create_agent_version', [agentId, specId, null]),
      'AGENT_NOT_FOUND_OR_FORBIDDEN',
    );
  });
});
