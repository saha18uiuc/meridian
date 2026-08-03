import {
  HUMAN_DECISION_SIGNAL,
  NEW_MESSAGE_SIGNAL,
  RECEIVING_WORKFLOW_TYPE,
  TEMPORAL_TASK_QUEUE,
} from '@meridian/core/temporal-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receivingWorkflow } from '../src/temporal/workflows/receiving-workflow.js';
import { createHarness, messageRef, receivingInput, type Harness } from './helpers/workflow-env.js';

/**
 * Signals, and the correlation they make possible.
 *
 * An arrival notice, its packing list, and its certificate of analysis arrive as three separate
 * emails, minutes apart, and they are one shipment. Signal-With-Start is what lets the second and
 * third find the run the first began: the workflow id is derived from the business key, so the
 * intake path either starts a run or hands a message to the one already open, without a lookup
 * table and without a race between two arrivals.
 *
 * The quiet period is the other half. A workflow that decided the instant the first message landed
 * would report `missing_information` for almost every real shipment.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.shutdown();
});

/** Answer any handoff the moment it is asked, so a case can reach its conclusion. */
function answering(workflowId: string): Record<string, never> {
  return {
    recordHumanDecisionRequest: (async (request: { requestId: string }) => {
      await harness.env.client.workflow.getHandle(workflowId).signal(HUMAN_DECISION_SIGNAL, {
        requestId: request.requestId,
        decision: 'hold_for_documents',
        notes: null,
      });
      return {};
    }) as never,
  };
}

describe('signal-with-start correlation', () => {
  it('collects later messages into the run the first one started', async () => {
    const workflowId = 'receiving:signal-correlation';
    const { worker, taskQueue } = await harness.worker(answering(workflowId));
    const input = receivingInput({
      executionId: '00000000-0000-4000-8000-000000000011',
      messageRefs: [messageRef('arrival-notice')],
    });

    const result = await worker.runUntil(async () => {
      const handle = await harness.env.client.workflow.signalWithStart(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [input],
        signal: NEW_MESSAGE_SIGNAL,
        signalArgs: [messageRef('packing-list', 'thread-2')],
      });
      // A third document, arriving while the run is already open. In production this is another
      // Signal-With-Start against the same derived id; here the handle makes the point directly.
      await handle.signal(NEW_MESSAGE_SIGNAL, [messageRef('certificate', 'thread-3')][0]);
      return handle.result();
    });

    expect(result.messageCount).toBe(3);
  });

  it('records every correlated thread against the intake step', async () => {
    const completion = harness.calls.find((call) => call.name === 'recorderCompleteStep');
    const output = (completion?.args[0] as { output: { threadIds: string[] } }).output;
    // Sorted, because the order three emails happen to arrive in is not information about the
    // shipment and would otherwise make the recorded evidence differ between identical runs.
    expect(output.threadIds).toEqual(['thread-1', 'thread-2', 'thread-3']);
  });

  it('ignores a redelivered message rather than counting it twice', async () => {
    const workflowId = 'receiving:signal-redelivery';
    const { worker, taskQueue } = await harness.worker(answering(workflowId));
    const input = receivingInput({
      executionId: '00000000-0000-4000-8000-000000000012',
      messageRefs: [messageRef('arrival-notice')],
    });

    const result = await worker.runUntil(async () => {
      const handle = await harness.env.client.workflow.start(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [input],
      });
      // At-least-once delivery is the normal case, not the exception: a webhook that times out is
      // retried, and the same provider message id arrives again.
      for (let i = 0; i < 3; i += 1) {
        await handle.signal(NEW_MESSAGE_SIGNAL, messageRef('arrival-notice'));
      }
      return handle.result();
    });

    expect(result.messageCount).toBe(1);
  });

  it('answers a human decision only for the request that asked', async () => {
    const workflowId = 'receiving:signal-wrong-request';
    const { worker, taskQueue } = await harness.worker({
      recordHumanDecisionRequest: (async () => {
        // A decision for a request id nobody is waiting on must not release the wait. Otherwise a
        // stale reply from a previous question would answer the current one.
        const handle = harness.env.client.workflow.getHandle(workflowId);
        await handle.signal(HUMAN_DECISION_SIGNAL, {
          requestId: 'handoff:some-other-run:1',
          decision: 'proceed',
          notes: null,
        });
        return {};
      }) as never,
    });

    const error = await worker
      .runUntil(
        harness.env.client.workflow.execute(receivingWorkflow, {
          workflowId,
          taskQueue,
          args: [
            receivingInput({
              executionId: '00000000-0000-4000-8000-000000000013',
              messageRefs: [messageRef('arrival-notice')],
            }),
          ],
        }),
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error & { cause?: Error },
      );

    expect(String(error?.cause?.message)).toMatch(/No human decision/);
  });

  it('names the signals the intake path and the operator UI actually send', () => {
    // These strings cross a process boundary, so they live in `@meridian/core` and both sides
    // import them. A literal on either side is a rename waiting to fail silently in production.
    expect(NEW_MESSAGE_SIGNAL).toBe('newMessage');
    expect(HUMAN_DECISION_SIGNAL).toBe('humanDecision');
    expect(RECEIVING_WORKFLOW_TYPE).toBe(receivingWorkflow.name);
    expect(TEMPORAL_TASK_QUEUE.length).toBeGreaterThan(0);
  });
});
