import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  buildSnapshot,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  truncateAll,
} from '../helpers/db.js';
import {
  idempotencyKey,
  seedAgentVersion,
  seedActiveAgent,
  type AgentFixture,
} from '../helpers/lineage.js';

/**
 * The policy gap (A13, A14).
 *
 * When an eval fails because the frozen specification simply does not say what to do, the honest
 * response is to stop and ask the operator — not to have the repair loop invent a policy and then
 * grade its own homework. `record_policy_gap` is that stop: it opens a completed system review
 * round carrying one blocking comment, so the question lands in the same place every other review
 * finding does.
 */

let owner: string;
let agent: AgentFixture;
let evalExecutionId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
  evalExecutionId = await createEvalExecution(agent, 'case-1');
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

async function createEvalExecution(fixture: AgentFixture, caseKey: string): Promise<string> {
  const created = await rpcAsService<{ executionId: string }>('create_execution', [
    fixture.agentId,
    fixture.agentVersionId,
    'eval',
    caseKey,
    null,
    null,
    idempotencyKey('eval', fixture.agentVersionId, caseKey),
    JSON.stringify({ fixture: caseKey }),
  ]);
  return created.executionId;
}

async function recordGap(
  failureKey: string,
  overrides: {
    agentVersionId?: string;
    evalExecutionId?: string;
    revisionNo?: number;
  } = {},
): Promise<{
  reviewSessionId?: string;
  commentId: string;
  issueKey: string;
  wasExisting: boolean;
}> {
  const { snapshot, hash, revisionNo } = await buildSnapshot(agent.boardId);
  return rpcAsService('record_policy_gap', [
    owner,
    agent.boardId,
    overrides.agentVersionId ?? agent.agentVersionId,
    overrides.evalExecutionId ?? evalExecutionId,
    failureKey,
    JSON.stringify(snapshot),
    hash,
    overrides.revisionNo ?? revisionNo,
  ]);
}

describe('record_policy_gap', () => {
  it('opens a completed system review round rather than a live one', async () => {
    const result = await recordGap('missing_free_time_policy');
    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string; model_name: string; completed_at: string | null }>(
        'select status, model_name, completed_at from public.review_sessions where review_session_id = $1',
        [result.reviewSessionId],
      ),
    );
    // Leaving it `running` would block every subsequent review on this board forever.
    expect(rows[0]).toMatchObject({ status: 'completed', model_name: 'eval-repair' });
    expect(rows[0]?.completed_at).not.toBeNull();
  });

  it('writes one blocking canvas comment carrying the eval that found it', async () => {
    const result = await recordGap('missing_free_time_policy');
    const { rows } = await asPostgres(async (client) =>
      client.query<{
        status: string;
        severity: string;
        anchor_type: string;
        issue_key: string;
        metadata_json: Record<string, unknown>;
      }>(
        `select status, severity, anchor_type, issue_key, metadata_json
           from public.comments where comment_id = $1`,
        [result.commentId],
      ),
    );
    expect(rows[0]).toMatchObject({
      status: 'open',
      severity: 'blocking',
      anchor_type: 'canvas',
      issue_key: 'gap:missing_free_time_policy:canvas:canvas:-',
    });
    expect(rows[0]?.metadata_json).toMatchObject({
      kind: 'policy_gap',
      evalRunId: evalExecutionId,
      failureKey: 'missing_free_time_policy',
      agentVersionId: agent.agentVersionId,
    });
  });

  it('normalizes a failure key into the issue-key alphabet instead of trusting it', async () => {
    const result = await recordGap('Missing Free-Time Policy!!');
    expect(result.issueKey).toBe('gap:missing_free_time_policy:canvas:canvas:-');
  });

  it('rejects a failure key that normalizes to nothing usable', async () => {
    await expectPgError(recordGap('!!'), 'INVALID_FAILURE_KEY');
  });

  it('is idempotent, so a rerun of the same failing eval does not pile up comments', async () => {
    const first = await recordGap('missing_free_time_policy');
    const second = await recordGap('missing_free_time_policy');
    expect(second).toMatchObject({
      commentId: first.commentId,
      wasExisting: true,
      code: 'POLICY_GAP_ALREADY_RECORDED',
    });

    const { rows } = await asPostgres(async (client) =>
      client.query<{ count: string }>('select count(*)::text as count from public.comments'),
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('blocks the freeze of the board it was recorded against', async () => {
    await recordGap('missing_free_time_policy');
    const { snapshot, hash, revisionNo } = await buildSnapshot(agent.boardId);
    await expectPgError(
      rpcAsService('freeze_whiteboard_spec', [
        owner,
        agent.boardId,
        revisionNo,
        JSON.stringify(snapshot),
        hash,
        JSON.stringify({
          identity: { specId: randomUUID(), whiteboardId: agent.boardId, specVersion: 2 },
        }),
        hash,
        [],
        false,
        true,
      ]),
      'UNRESOLVED_BLOCKERS',
    );
  });
});

describe('the lineage record_policy_gap insists on', () => {
  it('refuses an agent version that belongs to a different whiteboard', async () => {
    const other = await seedAgentVersion(owner);
    await expectPgError(
      recordGap('some_gap', { agentVersionId: other.agentVersionId }),
      'AGENT_VERSION_NOT_ON_WHITEBOARD',
    );
  });

  it('refuses an eval execution that belongs to a different version', async () => {
    const other = await seedActiveAgent(owner);
    const foreignEval = await createEvalExecution(other, 'case-foreign');
    await expectPgError(
      recordGap('some_gap', { evalExecutionId: foreignEval }),
      'EVAL_EXECUTION_NOT_ON_VERSION',
    );
  });

  it('refuses a live execution masquerading as the eval that found the gap', async () => {
    const live = await rpcAsService<{ executionId: string }>('create_execution', [
      agent.agentId,
      agent.agentVersionId,
      'live',
      'live:MSKU1234565',
      'MSKU1234565',
      'receiving:MSKU1234565',
      idempotencyKey('live', 'MSKU1234565', 'live:MSKU1234565'),
      JSON.stringify({}),
    ]);
    await expectPgError(
      recordGap('some_gap', { evalExecutionId: live.executionId }),
      'EVAL_EXECUTION_NOT_FOUND',
    );
  });

  it('refuses a stale board revision, because the gap must describe the board as it is', async () => {
    const { revisionNo } = await buildSnapshot(agent.boardId);
    await expectPgError(
      recordGap('some_gap', { revisionNo: revisionNo - 1 }),
      'STALE_BOARD_REVISION',
    );
  });

  it('refuses an actor who does not own the board', async () => {
    const [stranger] = (await createTestUsers(1)) as [string];
    const { snapshot, hash, revisionNo } = await buildSnapshot(agent.boardId);
    await expectPgError(
      rpcAsService('record_policy_gap', [
        stranger,
        agent.boardId,
        agent.agentVersionId,
        evalExecutionId,
        'some_gap',
        JSON.stringify(snapshot),
        hash,
        revisionNo,
      ]),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });

  it('refuses to run while a human review is still open on the board', async () => {
    const { snapshot, hash, revisionNo } = await buildSnapshot(agent.boardId);
    await rpcAsService('create_review_session', [
      owner,
      agent.boardId,
      revisionNo,
      JSON.stringify(snapshot),
      hash,
      'gpt-5.5',
      'high',
    ]);
    await expectPgError(recordGap('some_gap'), 'ACTIVE_REVIEW_EXISTS');
  });

  it('is not callable by the browser role', async () => {
    const { snapshot, hash, revisionNo } = await buildSnapshot(agent.boardId);
    await expectPgError(
      asPostgres(async (client) => {
        await client.query('set local role authenticated');
        await client.query('select public.record_policy_gap($1,$2,$3,$4,$5,$6,$7,$8)', [
          owner,
          agent.boardId,
          agent.agentVersionId,
          evalExecutionId,
          'some_gap',
          JSON.stringify(snapshot),
          hash,
          revisionNo,
        ]);
      }),
      'permission denied for function record_policy_gap',
    );
  });
});
