import { HUMAN_DECISION_SIGNAL, RECEIVING_WORKFLOW_TYPE } from '@meridian/core/temporal-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receivingWorkflow } from '../src/temporal/workflows/receiving-workflow.js';
import { createHarness, messageRef, receivingInput, type Harness } from './helpers/workflow-env.js';

/**
 * The receiving workflow, end to end, with stubbed activities.
 *
 * What is being checked here is orchestration, not extraction: that an intake step is open before
 * the workflow waits for anything, that the pinned agent is what runs, that a case the frozen spec
 * cannot decide reaches a human rather than being guessed at, and that the decision is recorded as
 * evidence. The activity bodies are stubs because their real versions talk to Gmail, OCR, and
 * PostgreSQL — running them would replace a precise claim about ordering with a vague one about
 * everything.
 *
 * The stubs return no attachments, so the agent has nothing to extract. That is not a degenerate
 * case: it is the arrival notice that turns up without its packing list, which is the single most
 * common real shape and the one that must escalate rather than fail.
 */

const HANDOFF_REQUEST_ID = 'handoff:intake:MSKU1234565:1';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.shutdown();
});

describe('the receiving workflow', () => {
  it('escalates to a human and finishes once the answer arrives', async () => {
    const workflowId = 'receiving:MSKU1234565';
    // The operator answers by replying to the question that was recorded, so the reply is wired to
    // the activity that records it. Polling from the test would race the environment's time
    // skipping, which can cross the twenty-four hour deadline in a few real milliseconds.
    const { worker, taskQueue } = await harness.worker({
      recordHumanDecisionRequest: (async (request: { requestId: string }) => {
        await harness.env.client.workflow.getHandle(workflowId).signal(HUMAN_DECISION_SIGNAL, {
          requestId: request.requestId,
          decision: 'hold_for_documents',
          notes: 'Forwarder has been asked for the packing list.',
        });
        return {};
      }) as never,
    });
    const input = receivingInput({ messageRefs: [messageRef('msg-1')] });

    const result = await worker.runUntil(
      harness.env.client.workflow.execute(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [input],
      }),
    );

    expect(result.executionId).toBe(input.executionId);
    expect(result.messageCount).toBe(1);
    expect(result.decision.outcome).toBe(result.outcome);
  });

  it('opens an intake step before it waits for anything', async () => {
    // The step has to exist before the quiet period, or a run that is still collecting messages
    // would show as having done nothing at all in the execution viewer.
    const first = harness.names().indexOf('recorderStartStep');
    expect(first).toBe(0);

    const call = harness.calls[first]?.args[0] as { stepKey: string; stepInstanceKey: string };
    expect(call.stepKey).toBe('intake');
    expect(call.stepInstanceKey).toBe('intake:MSKU1234565');
  });

  it('closes the intake step with what it actually collected', async () => {
    const completion = harness.calls.find((call) => call.name === 'recorderCompleteStep');
    expect(completion).toBeDefined();
    const output = (
      completion?.args[0] as { output: { messageCount: number; threadIds: string[] } }
    ).output;
    expect(output.messageCount).toBe(1);
    expect(output.threadIds).toEqual(['thread-1']);
  });

  it('asks the human a question that names the run it belongs to', async () => {
    const request = harness.calls.find((call) => call.name === 'recordHumanDecisionRequest');
    const payload = request?.args[0] as { requestId: string; question: string };
    expect(payload.requestId).toBe(HANDOFF_REQUEST_ID);
    expect(payload.question.length).toBeGreaterThan(0);
  });

  it('records the decision as evidence against the business key', async () => {
    const evidence = harness.calls
      .filter((call) => call.name === 'recorderAppendEvidence')
      .map((call) => call.args[0] as { eventKey?: string; payload: { phase?: string } });
    const decision = evidence.find((entry) => entry.payload.phase === 'decision');
    expect(decision?.eventKey).toBe('decision:MSKU1234565');
  });

  it('deduplicates a message that arrives as both the argument and the signal', async () => {
    const workflowId = 'receiving:dedupe';
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
    const duplicate = messageRef('msg-dupe');
    const input = receivingInput({
      executionId: '00000000-0000-4000-8000-000000000009',
      messageRefs: [duplicate],
    });

    const result = await worker.runUntil(async () => {
      const handle = await harness.env.client.workflow.start(receivingWorkflow, {
        workflowId,
        taskQueue,
        args: [input],
      });
      // Signal-With-Start passes the first message twice by construction, so the workflow must
      // treat "the message that started me" as an ordinary message it has already seen.
      await handle.signal('newMessage', duplicate);
      return handle.result();
    });

    expect(result.messageCount).toBe(1);
  });

  it('is registered under the type name the intake service starts', () => {
    expect(receivingWorkflow.name).toBe(RECEIVING_WORKFLOW_TYPE);
  });

  it('fails the execution when the worker holds code from a different spec', async () => {
    const { worker, taskQueue } = await harness.worker();
    const input = receivingInput({
      executionId: '00000000-0000-4000-8000-00000000000a',
      specHash: 'b'.repeat(64),
    });

    const error = await worker
      .runUntil(
        harness.env.client.workflow.execute(receivingWorkflow, {
          workflowId: 'receiving:wrong-hash',
          taskQueue,
          args: [input],
        }),
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );

    // The failure must be terminal. Before the sandbox errors were converted to application
    // failures this case did not fail at all — Temporal retried the workflow task forever and the
    // run simply hung, which is the worst of the available outcomes.
    expect(error).not.toBeNull();
    expect(String((error as Error & { cause?: Error }).cause?.message)).toMatch(
      /generated from a different frozen spec/,
    );
  });
});
