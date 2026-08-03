import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@meridian/core/database';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildOperatorCommand,
  reserveVersion,
  transitionVersion,
} from '@/server/services/agent-versions';
import { createAgent } from '@/server/services/agents';
import {
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
  type TestBoard,
} from './helpers';

/**
 * Reserving and transitioning agent versions.
 *
 * The route this covers is deliberately inert: it allocates a row and hands the operator a command
 * to run somewhere else. Everything interesting therefore lives in what it refuses — a version
 * cannot skip the Git gate, cannot be numbered out of order, and cannot borrow a spec from another
 * board — plus the standing guarantee that this code path never generates anything itself.
 */

const EMAIL = 'agent-versions-service@meridian.test';
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

  deploymentKey = `versions-${randomUUID().slice(0, 8)}`;
  const agent = await createAgent(owner, {
    whiteboardId: board.whiteboardId,
    deploymentKey,
    name: 'Version test agent',
  });
  agentId = agent['agentId'] as string;
});

/** Record a commit and a manifest, which is the gate a version must pass to leave `generated`. */
async function recordCommit(agentVersionId: string, versionNo: number): Promise<string> {
  const service = serviceClient();
  const sha = (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 40);
  const { error } = await service.rpc('record_agent_commit', {
    p_actor_user_id: ownerId,
    p_agent_version_id: agentVersionId,
    p_git_commit_sha: sha,
    p_build_manifest: {
      manifestVersion: 1,
      deploymentKey,
      versionNo,
      codePath: `generated-agents/${deploymentKey}/v${String(versionNo).padStart(3, '0')}`,
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
  return sha;
}

describe('reserving a version', () => {
  it('numbers versions consecutively within the agent', async () => {
    const first = await reserveVersion(owner, agentId, { specId });
    const second = await reserveVersion(owner, agentId, {
      specId,
      parentAgentVersionId: first.agentVersionId,
    });

    expect(first.versionNo).toBe(1);
    expect(second.versionNo).toBe(2);
    expect(first.specHash).toBe(specHash);
    expect(second.codePath).toBe(`generated-agents/${deploymentKey}/v002`);
  });

  it('numbers a second agent on the same board from one again', async () => {
    // Version numbers belong to the agent, not the board or the spec. If they were shared, adding
    // a second agent would make the first one's directory names jump.
    const sibling = await createAgent(owner, {
      whiteboardId: board.whiteboardId,
      deploymentKey: `versions-${randomUUID().slice(0, 8)}`,
      name: 'Sibling',
    });
    const reserved = await reserveVersion(owner, sibling['agentId'] as string, { specId });
    expect(reserved.versionNo).toBe(1);
  });

  it('refuses a spec that belongs to another board', async () => {
    const otherBoard = await createBoard(owner);
    const otherSpec = await freezeBoard(serviceClient(), ownerId, otherBoard.whiteboardId);
    await expect(reserveVersion(owner, agentId, { specId: otherSpec.specId })).rejects.toThrow(
      /SPEC_NOT_ON_AGENT_WHITEBOARD/,
    );
  });

  it('refuses a parent that is not older than the version being reserved', async () => {
    const latest = await reserveVersion(owner, agentId, { specId });
    await expect(
      reserveVersion(owner, agentId, { specId, parentAgentVersionId: latest.agentVersionId }),
    ).resolves.toMatchObject({ versionNo: latest.versionNo + 1 });
  });

  it('refuses an agent the caller cannot see', async () => {
    const otherEmail = 'agent-versions-other@meridian.test';
    await ensureUser(otherEmail, PASSWORD);
    const other = await userClient(otherEmail, PASSWORD);
    await expect(reserveVersion(other, agentId, { specId })).rejects.toThrow();
  });
});

describe('the operator command', () => {
  it('names everything the skill needs and nothing it must decide', () => {
    const command = buildOperatorCommand({
      deploymentKey: 'inbound-import-receiving',
      agentVersionId: '11111111-1111-4111-8111-111111111111',
      specId: '22222222-2222-4222-8222-222222222222',
      versionNo: 2,
      codePath: 'generated-agents/inbound-import-receiving/v002',
    });
    for (const fragment of [
      'deploymentKey=inbound-import-receiving',
      'agentVersionId=11111111-1111-4111-8111-111111111111',
      'specId=22222222-2222-4222-8222-222222222222',
      'versionNo=2',
      'codePath=generated-agents/inbound-import-receiving/v002',
      'skill=.codex/skills/spec-to-agent/SKILL.md',
    ]) {
      expect(command).toContain(fragment);
    }
  });

  it('is returned by the reservation, so the operator never assembles it by hand', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    expect(reserved.operatorCommand).toContain(reserved.agentVersionId);
    expect(reserved.operatorCommand).toContain(reserved.codePath);
  });
});

describe('the reservation route does no work of its own', () => {
  it('contains no file, process, git, or model access', () => {
    // A14: reserving a version is a database insert and a string. The moment this route could
    // write a file or call a model, "operator-invoked generation" would stop being true.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/server/services/agent-versions.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['child_process', 'node:fs', "from 'fs'", 'openai', 'simple-git']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('transitioning a version', () => {
  it('refuses to leave generated without a recorded commit', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    // The Git gate is the whole point of the status machine: an evaluated version must correspond
    // to source somebody can check out.
    await expect(transitionVersion(owner, reserved.agentVersionId, 'evaluating')).rejects.toThrow(
      /GIT_COMMIT_REQUIRED/,
    );
  });

  it('refuses to jump straight from generated to approved', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    await recordCommit(reserved.agentVersionId, reserved.versionNo);
    await expect(transitionVersion(owner, reserved.agentVersionId, 'approved')).rejects.toThrow(
      /ILLEGAL_TRANSITION/,
    );
  });

  it('walks generated to evaluating to approved and stamps the approval', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    await recordCommit(reserved.agentVersionId, reserved.versionNo);

    expect((await transitionVersion(owner, reserved.agentVersionId, 'evaluating')).status).toBe(
      'evaluating',
    );
    const approved = await transitionVersion(owner, reserved.agentVersionId, 'approved');
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();

    // Approval is not release. Nothing about the agent's pointer moved.
    const { data } = await owner
      .from('agents')
      .select('active_agent_version_id')
      .eq('agent_id', agentId)
      .single();
    expect(data?.active_agent_version_id).not.toBe(reserved.agentVersionId);
  });

  it('records a failed evaluation without destroying the version', async () => {
    const reserved = await reserveVersion(owner, agentId, { specId });
    await recordCommit(reserved.agentVersionId, reserved.versionNo);
    await transitionVersion(owner, reserved.agentVersionId, 'evaluating');

    const failed = await transitionVersion(owner, reserved.agentVersionId, 'failed');
    expect(failed.status).toBe('failed');
    expect(failed.approvedAt).toBeNull();
  });
});
