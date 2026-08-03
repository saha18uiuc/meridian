import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@meridian/core/database';
import { beforeAll, describe, expect, it } from 'vitest';
import { activateVersion } from '@/server/services/activation';
import { createAgent } from '@/server/services/agents';
import { reserveVersion, transitionVersion } from '@/server/services/agent-versions';
import {
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
  type TestBoard,
} from './helpers';

/**
 * The release pointer.
 *
 * Activation and rollback are the same operation aimed at different versions, which is the design:
 * rolling back is not an undo that discards anything, it is a normal release of an older approved
 * build. These tests hold that line — approval never releases anything on its own, and a version
 * that was never approved can never be released at all.
 */

const EMAIL = 'activation-service@meridian.test';
const OTHER_EMAIL = 'activation-other@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: SupabaseClient<Database>;
let ownerId: string;
let board: TestBoard;
let specId: string;
let specHash: string;
let agentId: string;
let deploymentKey: string;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);

  const spec = await freezeBoard(serviceClient(), ownerId, board.whiteboardId);
  specId = spec.specId;
  specHash = spec.specHash;

  deploymentKey = `activation-${randomUUID().slice(0, 8)}`;
  const agent = await createAgent(owner, {
    whiteboardId: board.whiteboardId,
    deploymentKey,
    name: 'Activation test agent',
  });
  agentId = agent['agentId'] as string;
});

/** Reserve, commit, evaluate, approve — the full path a version must walk to be releasable. */
async function approvedVersion(): Promise<{ agentVersionId: string; versionNo: number }> {
  const reserved = await reserveVersion(owner, agentId, { specId });
  const service = serviceClient();
  const { error } = await service.rpc('record_agent_commit', {
    p_actor_user_id: ownerId,
    p_agent_version_id: reserved.agentVersionId,
    p_git_commit_sha: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 40),
    p_build_manifest: {
      manifestVersion: 1,
      deploymentKey,
      versionNo: reserved.versionNo,
      codePath: reserved.codePath,
      specId,
      specHash,
      specVersion: 1,
      generatedFiles: ['agent.ts', 'rules.ts', 'prompts.ts', 'manifest.json', 'spec.snapshot.json'],
      capabilities: ['mail.read'],
      generatedAt: new Date().toISOString(),
      generator: { skill: 'spec-to-agent', model: 'service-test' },
      toolkitVersions: { composioGmailToolkit: '0.0.0-test' },
      validation: { commands: ['pnpm lint'], evalCaseKeys: [] },
    } as unknown as Json,
  });
  if (error !== null) throw new Error(error.message);

  await transitionVersion(owner, reserved.agentVersionId, 'evaluating');
  await transitionVersion(owner, reserved.agentVersionId, 'approved');
  return { agentVersionId: reserved.agentVersionId, versionNo: reserved.versionNo };
}

async function pointer(): Promise<string | null> {
  const { data } = await owner
    .from('agents')
    .select('active_agent_version_id')
    .eq('agent_id', agentId)
    .single();
  return data?.active_agent_version_id ?? null;
}

describe('activating a version', () => {
  it('does not happen as a side effect of approval', async () => {
    await approvedVersion();
    // Approving says the build is good. Releasing says it is what runs now. Conflating them means
    // an approval during business hours silently changes what every incoming message is handled by.
    expect(await pointer()).toBeNull();
  });

  it('moves the pointer and reports what it displaced', async () => {
    const v1 = await approvedVersion();
    const first = await activateVersion(owner, agentId, v1.agentVersionId);
    expect(first.activeAgentVersionId).toBe(v1.agentVersionId);
    expect(first.previousActiveAgentVersionId).toBeNull();
    expect(first.status).toBe('active');

    const v2 = await approvedVersion();
    const second = await activateVersion(owner, agentId, v2.agentVersionId);
    expect(second.activeAgentVersionId).toBe(v2.agentVersionId);
    expect(second.previousActiveAgentVersionId).toBe(v1.agentVersionId);
  });

  it('is a no-op when the version is already the release', async () => {
    const current = await pointer();
    expect(current).not.toBeNull();
    const again = await activateVersion(owner, agentId, current as string);
    expect(again.activeAgentVersionId).toBe(current);
    expect(await pointer()).toBe(current);
  });

  it('rolls back to an older approved version without discarding the newer one', async () => {
    const older = await approvedVersion();
    const newer = await approvedVersion();
    await activateVersion(owner, agentId, newer.agentVersionId);

    const rolledBack = await activateVersion(owner, agentId, older.agentVersionId);
    expect(rolledBack.activeAgentVersionId).toBe(older.agentVersionId);
    expect(rolledBack.previousActiveAgentVersionId).toBe(newer.agentVersionId);

    // The version that was rolled away from is still approved and still releasable. Rollback is a
    // release of something else, not a retraction.
    const { data } = await owner
      .from('agent_versions')
      .select('status')
      .eq('agent_version_id', newer.agentVersionId)
      .single();
    expect(data?.status).toBe('approved');
  });
});

describe('what cannot be released', () => {
  it('refuses a version that has not been approved', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    await expect(activateVersion(owner, agentId, reserved.agentVersionId)).rejects.toThrow(
      /VERSION_NOT_APPROVED|not approved/i,
    );
  });

  it('refuses a version that belongs to another agent', async () => {
    const sibling = await createAgent(owner, {
      whiteboardId: board.whiteboardId,
      deploymentKey: `activation-${randomUUID().slice(0, 8)}`,
      name: 'Sibling',
    });
    const mine = await pointer();
    expect(mine).not.toBeNull();

    await expect(
      activateVersion(owner, sibling['agentId'] as string, mine as string),
    ).rejects.toThrow(/VERSION_NOT_ON_AGENT|not/i);
  });

  it('refuses an activation from someone who does not own the agent', async () => {
    await ensureUser(OTHER_EMAIL, PASSWORD);
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    const target = await pointer();
    await expect(activateVersion(other, agentId, target as string)).rejects.toThrow();
    // The pointer is exactly where the owner left it.
    expect(await pointer()).toBe(target);
  });
});
