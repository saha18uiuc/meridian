import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@meridian/core/database';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  listAgentsForUser,
  requireOwnedBoardForAgent,
  setAgentStatus,
} from '@/server/services/agents';
import {
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
  type TestBoard,
} from './helpers';

/**
 * Logical agents, against the real database.
 *
 * An agent is a deployable identity, not a synonym for a board: one board can carry several, each
 * with its own deployment key, its own version series, and its own release pointer. These tests
 * are mostly about keeping those three separate, because the failure mode when they blur is an
 * operator pausing one agent and silently stopping another.
 */

const EMAIL = 'agents-service@meridian.test';
const OTHER_EMAIL = 'agents-other@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: SupabaseClient<Database>;
let ownerId: string;
let board: TestBoard;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);
});

function deploymentKey(): string {
  return `agents-${randomUUID().slice(0, 8)}`;
}

describe('creating agents', () => {
  it('allows two agents to share one board', async () => {
    const first = await createAgent(owner, {
      whiteboardId: board.whiteboardId,
      deploymentKey: deploymentKey(),
      name: 'Receiving',
    });
    const second = await createAgent(owner, {
      whiteboardId: board.whiteboardId,
      deploymentKey: deploymentKey(),
      name: 'Exceptions',
    });

    expect(first['agentId']).not.toBe(second['agentId']);
    expect(first['status']).toBe('draft');

    const listed = await listAgentsForUser(owner, board.whiteboardId);
    const ids = listed.map((agent) => agent.agentId);
    expect(ids).toContain(first['agentId']);
    expect(ids).toContain(second['agentId']);
  });

  it('refuses a deployment key that is already taken anywhere', async () => {
    const key = deploymentKey();
    await createAgent(owner, { whiteboardId: board.whiteboardId, deploymentKey: key, name: 'One' });
    // The key names a deployment, not a row, so it has to be unique across the whole system —
    // otherwise two agents would resolve to the same worker registry entry.
    await expect(
      createAgent(owner, { whiteboardId: board.whiteboardId, deploymentKey: key, name: 'Two' }),
    ).rejects.toThrow(/DEPLOYMENT_KEY_TAKEN/);
  });

  it('refuses a malformed deployment key', async () => {
    await expect(
      createAgent(owner, {
        whiteboardId: board.whiteboardId,
        deploymentKey: 'Not A Key',
        name: 'Bad',
      }),
    ).rejects.toThrow(/INVALID_DEPLOYMENT_KEY/);
  });

  it('refuses a board the caller does not own', async () => {
    const otherId = await ensureUser(OTHER_EMAIL, PASSWORD);
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    await expect(
      createAgent(other, {
        whiteboardId: board.whiteboardId,
        deploymentKey: deploymentKey(),
        name: 'Intruder',
      }),
    ).rejects.toThrow(/WHITEBOARD_NOT_FOUND_OR_FORBIDDEN/);
    await expect(requireOwnedBoardForAgent(other, otherId, board.whiteboardId)).rejects.toThrow(
      /WHITEBOARD/,
    );
  });
});

describe('listing agents', () => {
  it('shows only the caller their own agents', async () => {
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    const mine = await listAgentsForUser(owner);
    const theirs = await listAgentsForUser(other);

    expect(mine.length).toBeGreaterThan(0);
    const myIds = new Set(mine.map((agent) => agent.agentId));
    // Row-level security is doing this, not a filter in the query. The service passes no owner.
    expect(theirs.some((agent) => myIds.has(agent.agentId))).toBe(false);
  });

  it('narrows to one board when asked', async () => {
    const otherBoard = await createBoard(owner);
    await createAgent(owner, {
      whiteboardId: otherBoard.whiteboardId,
      deploymentKey: deploymentKey(),
      name: 'Elsewhere',
    });
    const listed = await listAgentsForUser(owner, otherBoard.whiteboardId);
    expect(listed.length).toBe(1);
    expect(listed[0]?.whiteboardId).toBe(otherBoard.whiteboardId);
  });
});

describe('the agent status lifecycle', () => {
  let agentId: string;

  beforeAll(async () => {
    const service = serviceClient();
    const spec = await freezeBoard(service, ownerId, board.whiteboardId);
    const { activeAgent } = await import('./helpers');
    const active = await activeAgent(
      service,
      owner,
      ownerId,
      board.whiteboardId,
      spec.specId,
      spec.specHash,
    );
    agentId = active.agentId;
  });

  it('walks draft to active to paused and back to active', async () => {
    // The round trip is the point: pausing has to be reversible, or an operator who pauses an
    // agent during an incident has no way to resume it without cutting a new version.
    expect((await setAgentStatus(owner, ownerId, agentId, 'paused')).status).toBe('paused');
    expect((await setAgentStatus(owner, ownerId, agentId, 'active')).status).toBe('active');
    expect((await setAgentStatus(owner, ownerId, agentId, 'paused')).status).toBe('paused');
  });

  it('is idempotent when the status does not change', async () => {
    await setAgentStatus(owner, ownerId, agentId, 'paused');
    expect((await setAgentStatus(owner, ownerId, agentId, 'paused')).status).toBe('paused');
  });

  it('refuses a status change from someone who does not own the agent', async () => {
    const otherId = await ensureUser(OTHER_EMAIL, PASSWORD);
    const other = await userClient(OTHER_EMAIL, PASSWORD);
    await expect(setAgentStatus(other, otherId, agentId, 'archived')).rejects.toThrow(/AGENT/);

    // And the refusal must not have half-applied: the row is untouched.
    const listed = await listAgentsForUser(owner, board.whiteboardId);
    expect(listed.find((agent) => agent.agentId === agentId)?.status).toBe('paused');
  });

  it('archives, dropping the release pointer, and that is the end of the line', async () => {
    const archived = await setAgentStatus(owner, ownerId, agentId, 'archived');
    expect(archived.status).toBe('archived');

    const listed = await listAgentsForUser(owner, board.whiteboardId);
    // An archived agent that still named a release would keep resolving for live intake.
    expect(listed.find((agent) => agent.agentId === agentId)?.activeAgentVersionId).toBeNull();

    await expect(setAgentStatus(owner, ownerId, agentId, 'active')).rejects.toThrow(
      /ILLEGAL_TRANSITION|archived/i,
    );
  });
});
