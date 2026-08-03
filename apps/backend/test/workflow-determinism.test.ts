import { HUMAN_DECISION_SIGNAL } from '@meridian/core/temporal-contract';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receivingWorkflow } from '../src/temporal/workflows/receiving-workflow.js';
import {
  createHarness,
  messageRef,
  receivingInput,
  WORKFLOWS_PATH,
  type Harness,
} from './helpers/workflow-env.js';

/**
 * Replay, which is the property everything else in the workflow layer is arranged to protect.
 *
 * Temporal recovers a run by re-executing its code against the recorded history. If the code takes
 * a different path the second time — because it read a clock, generated a UUID, iterated a `Set`
 * built from unsorted input, or awaited promises in a scheduling-dependent order — the replay
 * diverges and the run is unrecoverable. The failure surfaces during an outage, which is precisely
 * when nobody can afford to debug it.
 *
 * A replay test is the only honest check. Reading the source catches the obvious imports;
 * re-running a real history against the current code catches the rest.
 */

let harness: Harness;
let histories: Awaited<ReturnType<typeof collectHistories>>;

async function collectHistories(): Promise<{ id: string; history: unknown }[]> {
  const workflowId = 'receiving:determinism';
  const { worker, taskQueue } = await harness.worker({
    recordHumanDecisionRequest: (async (request: { requestId: string }) => {
      await harness.env.client.workflow.getHandle(workflowId).signal(HUMAN_DECISION_SIGNAL, {
        requestId: request.requestId,
        decision: 'hold_for_documents',
        notes: null,
      });
      return {};
    }) as never,
  });

  await worker.runUntil(async () => {
    const handle = await harness.env.client.workflow.start(receivingWorkflow, {
      workflowId,
      taskQueue,
      args: [
        receivingInput({
          executionId: '00000000-0000-4000-8000-000000000041',
          // Three threads, supplied out of order on purpose: anything that iterates them without
          // sorting will replay differently once the history fixes an order.
          messageRefs: [
            messageRef('m-3', 'thread-c'),
            messageRef('m-1', 'thread-a'),
            messageRef('m-2', 'thread-b'),
          ],
        }),
      ],
    });
    const finished = handle.result();
    await handle.signal('newMessage', messageRef('m-4', 'thread-a'));
    return finished;
  });

  const handle = harness.env.client.workflow.getHandle(workflowId);
  return [{ id: workflowId, history: await handle.fetchHistory() }];
}

beforeAll(async () => {
  harness = await createHarness();
  histories = await collectHistories();
});

afterAll(async () => {
  await harness.shutdown();
});

describe('the receiving workflow replays', () => {
  it('produced a history worth replaying', () => {
    expect(histories).toHaveLength(1);
  });

  it('replays its own history against the current code without diverging', async () => {
    // `runReplayHistory` throws `DeterminismViolationError` on divergence. Passing means the code
    // now in the repository would recover this run, not merely that it once ran.
    for (const { history } of histories) {
      await expect(
        Worker.runReplayHistory(
          { workflowsPath: WORKFLOWS_PATH, replayName: 'receiving' },
          history,
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('sorts the correlated threads, so the recorded order is not an accident of arrival', () => {
    const completion = harness.calls.find(
      (call) =>
        call.name === 'recorderCompleteStep' &&
        Array.isArray((call.args[0] as { output: { threadIds?: string[] } }).output.threadIds),
    );
    const threadIds = (completion?.args[0] as { output: { threadIds: string[] } }).output.threadIds;
    expect(threadIds).toEqual(['thread-a', 'thread-b', 'thread-c']);
  });

  it('derives step instance keys from the business key rather than from a counter', () => {
    // A counter would be stable under replay but not under a signal arriving at a different point
    // in the history, which is the case that actually happens.
    const keys = harness.calls
      .filter((call) => call.name === 'recorderStartStep')
      .map((call) => (call.args[0] as { stepInstanceKey: string }).stepInstanceKey);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/MSKU1234565/);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});
