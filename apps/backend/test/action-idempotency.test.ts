import { HUMAN_DECISION_SIGNAL } from '@meridian/core/temporal-contract';
import { NonRetryableToolError } from '@meridian/agent-kit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkflowRecorder,
  workflowIdempotency,
} from '../src/temporal/workflows/tool-proxies.js';
import { receivingWorkflow } from '../src/temporal/workflows/receiving-workflow.js';
import { createHarness, messageRef, receivingInput, type Harness } from './helpers/workflow-env.js';

/**
 * The one thing a retry must never do: send the email twice.
 *
 * Everything else in this system can be replayed safely because it is a write to a table we
 * control. An outbound email is not: once it leaves, no amount of rollback retrieves it, and a
 * forwarder who receives the same "please send the packing list" three times learns to ignore all
 * of them.
 *
 * The protection is structural rather than careful. Workflow code cannot send at all — the mailbox
 * proxy's `sendDraft` refuses — and the only route out of the process is `performMailAction`,
 * which reserves against a derived idempotency key inside a single activity before dispatching.
 * A replayed workflow reaches the identical reservation and finds it already spent.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.shutdown();
});

describe('the workflow-side action surface', () => {
  it('refuses to send a draft from workflow code', async () => {
    const registry = (
      await import('../src/temporal/workflows/tool-proxies.js')
    ).createWorkflowToolRegistry({
      executionId: 'e1',
      capabilities: ['mail.send'],
      toolkitVersion: '20250101_00',
      decisions: new Map(),
      currentStepInstanceKey: () => 'respond:MSKU1234565',
      currentStepExecutionId: () => 'step-1',
    });

    await expect(registry.mailbox.sendDraft('draft-1')).rejects.toThrow(NonRetryableToolError);
    await expect(registry.mailbox.sendDraft('draft-1')).rejects.toThrow(/reserved, dispatched/);
  });

  it('refuses to derive an action key inside the sandbox', () => {
    // The key is a SHA-256 of four inputs and the sandbox has no crypto. Deriving it in the
    // activity from the same four inputs is what makes a replay land on the same reservation;
    // a key computed in workflow code would have to be threaded through and could drift.
    expect(() =>
      workflowIdempotency.deriveActionKey({
        executionId: 'e1',
        stepInstanceKey: 'respond:MSKU1234565',
        actionType: 'mail.send',
        payload: {},
      }),
    ).toThrow(/derived inside the activity/);
  });

  it('still exposes the marker token, which is a pure string operation', () => {
    // The token is appended to the outgoing body so a reconciliation search can recognise a send
    // that escaped before its acknowledgement came back.
    expect(workflowIdempotency.markerToken('a'.repeat(64))).toBe('a'.repeat(12));
  });

  it('refuses reconciliation calls from workflow code', async () => {
    const recorder = createWorkflowRecorder('e1');
    for (const call of [
      () => recorder.reserveAction(null, 'mail.send', {}),
      () => recorder.dispatchAction('a1'),
      () => recorder.completeAction('a1', { status: 'succeeded' }),
      () => recorder.markActionForReconciliation('a1', {}),
      () =>
        recorder.reconcileAction('a1', 'succeeded', null, {
          provenNotDelivered: false,
          method: 'search',
          query: 'x',
          matchedProviderActionId: null,
          searchedAt: '2026-01-01T00:00:00.000Z',
        }),
      () => recorder.abandonAction('a1', {}),
    ]) {
      // Crash recovery decides whether a send may already have escaped. That is a runtime
      // judgement about the outside world, and workflow code has no way to make it.
      await expect(call()).rejects.toThrow(/not callable from workflow code/);
    }
  });
});

describe('an external action under replay', () => {
  it('dispatches once even when the workflow is replayed', async () => {
    const workflowId = 'receiving:action-once';
    const dispatched: string[] = [];
    let downloadAttempts = 0;

    const { worker, taskQueue } = await harness.worker({
      // A transient failure after the intake step forces Temporal to replay the workflow from the
      // start of its history, which is exactly the situation a duplicate send would arise in.
      mailDownloadAttachments: async () => {
        downloadAttempts += 1;
        if (downloadAttempts < 2) throw new Error('the mail provider returned 503');
        return [];
      },
      performMailAction: (async (request: { payload: { to: string } }) => {
        dispatched.push(request.payload.to);
        return { status: 'succeeded', providerActionId: `provider-${String(dispatched.length)}` };
      }) as never,
      recordHumanDecisionRequest: (async (request: { requestId: string }) => {
        await harness.env.client.workflow.getHandle(workflowId).signal(HUMAN_DECISION_SIGNAL, {
          requestId: request.requestId,
          decision: 'request_documents',
          notes: null,
        });
        return {};
      }) as never,
    });

    await worker.runUntil(
      harness.env.client.workflow.execute(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [
          receivingInput({
            executionId: '00000000-0000-4000-8000-000000000031',
            messageRefs: [messageRef('arrival-notice')],
          }),
        ],
      }),
    );

    expect(downloadAttempts).toBe(2);
    // At most one dispatch, despite the replay. Zero is also correct here — whether this case
    // sends at all is the agent's decision — but two would mean a duplicate email.
    expect(dispatched.length).toBeLessThanOrEqual(1);
  });

  it('routes every send through the reserve-and-dispatch activity', () => {
    // If the agent had reached Gmail any other way, there would be a `mailCreateDraft` or a raw
    // send in the recorded calls without a `performMailAction` beside it.
    const rawSends = harness
      .names()
      .filter((name) => name === 'mailSendDraft' || name === 'mailSendMessage');
    expect(rawSends).toEqual([]);
  });
});
