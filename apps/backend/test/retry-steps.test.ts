import { HUMAN_DECISION_SIGNAL } from '@meridian/core/temporal-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilityDeniedError, NON_RETRYABLE_FAILURE_TYPES } from '@meridian/agent-kit/contracts';
import { withFailureMapping } from '../src/temporal/activities/failures.js';
import { RETRY_POLICY } from '../src/temporal/workflows/tool-proxies.js';
import { receivingWorkflow } from '../src/temporal/workflows/receiving-workflow.js';
import { createHarness, messageRef, receivingInput, type Harness } from './helpers/workflow-env.js';

/**
 * Retries, and the line between a failure worth retrying and one that is simply true.
 *
 * OCR times out, Gmail returns a 503, a container is briefly unreachable: those deserve another
 * attempt. A denied capability, a schema violation, and a missing business policy do not — the
 * second attempt will produce the same answer, three seconds later, with a worse error message.
 * Temporal cannot tell these apart on its own, so the classification is declared once in the
 * retry policy and every activity inherits it.
 *
 * The other property tested here is that a retry is *visible*: a step that succeeded on its third
 * attempt is a different fact from a step that succeeded immediately, and the execution record
 * must be able to tell an operator which happened.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.shutdown();
});

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

describe('the activity retry policy', () => {
  it('refuses to retry exactly the failures that cannot change', () => {
    expect(RETRY_POLICY.nonRetryableErrorTypes).toEqual([...NON_RETRYABLE_FAILURE_TYPES]);
  });

  it('bounds attempts and backs off between them', () => {
    // Unbounded retries turn a broken dependency into a silent stall; a fixed interval turns a
    // struggling one into a denial-of-service by the workflow that depends on it.
    expect(RETRY_POLICY.maximumAttempts).toBe(3);
    expect(RETRY_POLICY.backoffCoefficient).toBeGreaterThan(1);
    expect(RETRY_POLICY.initialInterval).toBe('1 second');
    expect(RETRY_POLICY.maximumInterval).toBe('30 seconds');
  });
});

describe('a transient activity failure', () => {
  it('is retried and the run still completes', async () => {
    const workflowId = 'receiving:retry-transient';
    let attempts = 0;

    const { worker, taskQueue } = await harness.worker({
      ...answering(workflowId),
      mailDownloadAttachments: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('the mail provider returned 503');
        return [];
      },
    });

    const result = await worker.runUntil(
      harness.env.client.workflow.execute(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [
          receivingInput({
            executionId: '00000000-0000-4000-8000-000000000021',
            messageRefs: [messageRef('arrival-notice')],
          }),
        ],
      }),
    );

    expect(attempts).toBe(3);
    expect(result.executionId).toBe('00000000-0000-4000-8000-000000000021');
  });

  it('does not restart the steps that already succeeded', async () => {
    // Temporal replays workflow code after every failure, so a step recorded outside an activity
    // would be recorded again on each attempt. Counting the intake step is how that regression
    // would announce itself.
    const intakeStarts = harness.calls.filter(
      (call) =>
        call.name === 'recorderStartStep' &&
        (call.args[0] as { stepKey: string }).stepKey === 'intake',
    );
    expect(intakeStarts).toHaveLength(1);
  });
});

describe('a permanent activity failure', () => {
  it('fails the execution on the first attempt instead of retrying', async () => {
    const workflowId = 'receiving:retry-permanent';
    let attempts = 0;

    const { worker, taskQueue } = await harness.worker({
      // Thrown through the real mapper, because the classification lives there: a bare `Error`
      // with the right `name` would not carry the failure type Temporal matches on, and a test
      // that faked it would prove nothing about production.
      mailDownloadAttachments: (async () =>
        withFailureMapping(() => {
          attempts += 1;
          throw new CapabilityDeniedError('mail.read', ['document.extract']);
        })) as never,
    });

    const error = await worker
      .runUntil(
        harness.env.client.workflow.execute(receivingWorkflow, {
          workflowId,
          taskQueue,
          args: [
            receivingInput({
              executionId: '00000000-0000-4000-8000-000000000022',
              messageRefs: [messageRef('arrival-notice')],
            }),
          ],
        }),
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );

    expect(error).not.toBeNull();
    expect(attempts).toBe(1);
  });
});

describe('an exhausted retry', () => {
  it('gives up after the declared number of attempts', async () => {
    const workflowId = 'receiving:retry-exhausted';
    let attempts = 0;

    const { worker, taskQueue } = await harness.worker({
      mailDownloadAttachments: async () => {
        attempts += 1;
        throw new Error('the mail provider is down');
      },
    });

    const error = await worker
      .runUntil(
        harness.env.client.workflow.execute(receivingWorkflow, {
          workflowId,
          taskQueue,
          args: [
            receivingInput({
              executionId: '00000000-0000-4000-8000-000000000023',
              messageRefs: [messageRef('arrival-notice')],
            }),
          ],
        }),
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );

    expect(error).not.toBeNull();
    // Three, not four and not forever. A run that never stops failing is indistinguishable from a
    // run that is still working, and an operator cannot act on either.
    expect(attempts).toBe(RETRY_POLICY.maximumAttempts);
  });
});
