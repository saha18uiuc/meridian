import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@meridian/core/database';
import { executionIdempotencyKey } from '@meridian/ops/intake';
import type { Client } from '@temporalio/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { activateVersion } from '@/server/services/activation';
import { reserveVersion, transitionVersion } from '@/server/services/agent-versions';
import { setAgentStatus } from '@/server/services/agents';
import {
  applyCommentPatch,
  recordAssumption,
  rejectComment,
  replyToComment,
} from '@/server/services/comment-actions';
import { getExecutionDetail, submitHumanDecision } from '@/server/services/executions';
import { freezePreview, freezeSpec } from '@/server/services/freeze-spec';
import { startLiveRun } from '@/server/services/intake';
import { runReview } from '@/server/services/run-review';
import { saveWhiteboardDelta } from '@/server/services/save-whiteboard-delta';
import {
  activeAgent,
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
} from './helpers';

/**
 * Verification item 117: identifier substitution.
 *
 * Every service in this file eventually reaches for the service-role client, which bypasses RLS
 * completely. The only thing standing between that client and another person's data is the
 * ownership re-derivation each service performs first, with the *caller's* client, before anything
 * privileged runs. This test is the adversary: User B holds every one of User A's identifiers and
 * calls every one of those services with them.
 *
 * Two properties are asserted each time. The call must fail — never return data — and it must fail
 * without leaving a partial write behind, which is checked by comparing User A's board revision and
 * row counts before and after the whole assault.
 */

const OWNER_EMAIL = 'substitution-owner@meridian.test';
const INTRUDER_EMAIL = 'substitution-intruder@meridian.test';
const PASSWORD = 'meridian-test-password';

let service: SupabaseClient<Database>;
let owner: SupabaseClient<Database>;
let ownerId: string;
let intruder: SupabaseClient<Database>;
let intruderId: string;

const victim = {
  whiteboardId: '',
  revisionNo: 0,
  specId: '',
  agentId: '',
  agentVersionId: '',
  executionId: '',
  commentId: '',
  reviewSessionId: '',
};

function inertTemporal(): Client {
  const trap = vi.fn(() => {
    throw new Error('a rejected request must never reach Temporal');
  });
  return {
    workflow: { start: trap, signalWithStart: trap, signal: trap, getHandle: trap },
  } as unknown as Client;
}

beforeAll(async () => {
  service = serviceClient();
  ownerId = await ensureUser(OWNER_EMAIL, PASSWORD);
  owner = await userClient(OWNER_EMAIL, PASSWORD);
  intruderId = await ensureUser(INTRUDER_EMAIL, PASSWORD);
  intruder = await userClient(INTRUDER_EMAIL, PASSWORD);

  const board = await createBoard(owner);
  victim.whiteboardId = board.whiteboardId;

  const review = await runReview(owner, ownerId, board.whiteboardId, board.revisionNo);
  victim.reviewSessionId = review.reviewSessionId;
  const { data: roots } = await owner
    .from('comments')
    .select('comment_id, severity')
    .eq('whiteboard_id', board.whiteboardId)
    .is('parent_comment_id', null);
  victim.commentId = roots?.[0]?.comment_id ?? '';

  // The reviewer always raises at least one blocking question, and `freezeBoard` does not
  // acknowledge anything. Settling them here keeps this file about authorization.
  for (const root of roots ?? []) {
    if (root.severity === 'blocking') {
      await rejectComment(owner, root.comment_id, 'Out of scope for this fixture.');
    }
  }

  const spec = await freezeBoard(service, ownerId, board.whiteboardId);
  victim.specId = spec.specId;

  const agent = await activeAgent(
    service,
    owner,
    ownerId,
    board.whiteboardId,
    spec.specId,
    spec.specHash,
  );
  victim.agentId = agent.agentId;
  victim.agentVersionId = agent.agentVersionId;

  const businessKey = `MSKU${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}0`;
  const caseKey = `live:${businessKey}`;
  const { data, error } = await service.rpc('create_execution', {
    p_agent_id: agent.agentId,
    p_agent_version_id: agent.agentVersionId,
    p_run_type: 'live',
    p_case_key: caseKey,
    p_business_key: businessKey,
    p_temporal_workflow_id: `receiving-${businessKey}`,
    p_idempotency_key: executionIdempotencyKey('live', businessKey, caseKey),
    p_input_ref: {} as unknown as Json,
  });
  if (error !== null) throw new Error(error.message);
  victim.executionId = (data as unknown as { executionId: string }).executionId;

  const { data: current } = await owner
    .from('whiteboards')
    .select('revision_no')
    .eq('whiteboard_id', board.whiteboardId)
    .single();
  victim.revisionNo = current?.revision_no ?? 0;
});

/** A snapshot of everything a partial write would disturb. */
async function fingerprint() {
  const [board, nodes, comments, specs, versions, events] = await Promise.all([
    owner
      .from('whiteboards')
      .select('revision_no, status, title')
      .eq('whiteboard_id', victim.whiteboardId)
      .single(),
    owner.from('whiteboard_nodes').select('node_id').eq('whiteboard_id', victim.whiteboardId),
    owner.from('comments').select('comment_id').eq('whiteboard_id', victim.whiteboardId),
    owner.from('frozen_specs').select('spec_id').eq('whiteboard_id', victim.whiteboardId),
    owner.from('agent_versions').select('agent_version_id').eq('agent_id', victim.agentId),
    owner.from('execution_events').select('event_key').eq('execution_id', victim.executionId),
  ]);
  return {
    revisionNo: board.data?.revision_no,
    status: board.data?.status,
    title: board.data?.title,
    nodes: nodes.data?.length ?? 0,
    comments: comments.data?.length ?? 0,
    specs: specs.data?.length ?? 0,
    versions: versions.data?.length ?? 0,
    // The keys, not the count. A count says something moved; the key says what wrote it, which is
    // the only part of this fingerprint anyone can act on when it fails.
    events: (events.data ?? []).map((row) => row.event_key).sort(),
  };
}

describe('substituting another user’s identifiers', () => {
  it('refuses every service that reaches for the service-role client', async () => {
    const before = await fingerprint();

    const attempts: [string, Promise<unknown>][] = [
      [
        'save a graph delta',
        saveWhiteboardDelta(intruder, victim.whiteboardId, {
          expectedRevisionNo: victim.revisionNo,
          nodeUpserts: [
            {
              nodeId: randomUUID(),
              primitiveType: 'outcome',
              title: 'Injected',
              data: { resultKind: 'ready', terminal: true },
              position: { x: 0, y: 0 },
            },
          ],
          nodeDeletes: [],
          edgeUpserts: [],
          edgeDeletes: [],
          viewport: null,
        }),
      ],
      ['run a review', runReview(intruder, intruderId, victim.whiteboardId, victim.revisionNo)],
      ['read a freeze preview', freezePreview(intruder, victim.whiteboardId)],
      [
        'freeze a spec',
        freezeSpec(intruder, intruderId, victim.whiteboardId, {
          expectedRevisionNo: victim.revisionNo,
          acknowledgeUnresolvedBlockers: true,
          acknowledgeStaleReview: true,
        }),
      ],
      ['reply to a comment', replyToComment(intruder, victim.commentId, 'Injected reply.')],
      ['reject a comment', rejectComment(intruder, victim.commentId, 'Injected reason.')],
      [
        'record an assumption',
        recordAssumption(intruder, victim.commentId, 'Injected assumption.'),
      ],
      ['apply a comment patch', applyCommentPatch(intruder, victim.commentId, victim.revisionNo)],
      ['reserve a version', reserveVersion(intruder, victim.agentId, { specId: victim.specId })],
      ['transition a version', transitionVersion(intruder, victim.agentVersionId, 'failed')],
      ['activate a version', activateVersion(intruder, victim.agentId, victim.agentVersionId)],
      ['pause an agent', setAgentStatus(intruder, intruderId, victim.agentId, 'paused')],
      ['read an execution', getExecutionDetail(intruder, victim.executionId)],
      [
        'answer a human decision',
        submitHumanDecision(
          intruder,
          victim.executionId,
          { requestId: randomUUID(), decision: 'approve', notes: null },
          { temporal: inertTemporal(), service },
        ),
      ],
      [
        'start a live run',
        startLiveRun(
          intruder,
          victim.agentId,
          {
            provider: 'gmail',
            providerMessageId: `<injected-${randomUUID()}@example.test>`,
            threadId: 'injected',
            subject: 'Container MSKU1234565 arriving',
            receivedAt: '2026-02-11T00:00:00.000Z',
            storagePath: null,
          },
          { subject: 'Container MSKU1234565 arriving', bodyText: 'Injected.' },
          { temporal: inertTemporal(), service },
        ),
      ],
    ];

    const settled = await Promise.allSettled(attempts.map(([, promise]) => promise));
    const succeeded = settled
      .map((outcome, index) => ({ outcome, name: attempts[index]?.[0] ?? '' }))
      .filter((entry) => entry.outcome.status === 'fulfilled')
      .map((entry) => entry.name);
    expect(succeeded).toEqual([]);

    // Nothing moved. A service that checked ownership *after* its first write would show up here
    // even though its final answer was a rejection.
    expect(await fingerprint()).toEqual(before);
  });

  it('does not confirm that the identifiers exist', async () => {
    // The failures must be indistinguishable from the ones a made-up identifier produces, or the
    // error message itself becomes an oracle for which UUIDs are real.
    const fake = randomUUID();
    const realMessage = await freezePreview(intruder, victim.whiteboardId).catch(
      (error: Error) => error.message,
    );
    const fakeMessage = await freezePreview(intruder, fake).catch((error: Error) => error.message);
    expect(realMessage).toBe(fakeMessage);

    const realExecution = await getExecutionDetail(intruder, victim.executionId).catch(
      (error: Error) => error.message,
    );
    const fakeExecution = await getExecutionDetail(intruder, fake).catch(
      (error: Error) => error.message,
    );
    expect(realExecution).toBe(fakeExecution);
  });

  it('leaves the owner able to do all of it themselves', async () => {
    // The point of the check is that ownership is what was missing, not that the operations are
    // broken. Each of these is one of the calls the intruder was just refused.
    await expect(freezePreview(owner, victim.whiteboardId)).resolves.toBeDefined();
    await expect(getExecutionDetail(owner, victim.executionId)).resolves.toBeDefined();
    await expect(
      replyToComment(owner, victim.commentId, 'Confirmed with the broker.'),
    ).resolves.toBeDefined();
  });
});
