import { fileURLToPath } from 'node:url';
import type { MessageRef } from '@meridian/core/schemas';
import { AGENT_REGISTRY } from '@meridian/generated-agents';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type WorkerOptions } from '@temporalio/worker';
import type { Activities } from '../../src/temporal/activities/index.js';
import type { ReceivingInput } from '../../src/temporal/workflows/receiving-workflow.js';

/**
 * A time-skipping Temporal environment with every activity replaced by a recorder.
 *
 * The workflow tests are about orchestration — what is called, in what order, how many times, and
 * what happens on retry — so the activities are stubs by design. Their real bodies talk to Gmail,
 * OCR, and PostgreSQL, all of which have their own tests; running them here would turn a
 * determinism test into an integration test and hide the thing being checked.
 *
 * Time skipping is what makes the quiet period and the 24-hour human-decision timeout testable at
 * all. Without it a single case would take a day.
 */

export const WORKFLOWS_PATH = fileURLToPath(
  new URL('../../src/temporal/workflows/index.ts', import.meta.url),
);

export interface ActivityCall {
  name: string;
  args: unknown[];
}

export interface Harness {
  env: TestWorkflowEnvironment;
  calls: ActivityCall[];
  /** Names only, in call order — the usual assertion. */
  names: () => string[];
  countOf: (name: string) => number;
  /** A worker on a task queue of its own; Temporal refuses two workers on one queue. */
  worker: (overrides?: Partial<Activities>) => Promise<{ worker: Worker; taskQueue: string }>;
  shutdown: () => Promise<void>;
}

let stepCounter = 0;
let queueCounter = 0;

/** Default stubs: enough shape for the workflow to proceed, no behaviour of their own. */
function defaultActivities(record: (call: ActivityCall) => void): Activities {
  const stub =
    (name: string, result: unknown = {}) =>
    async (...args: unknown[]): Promise<unknown> => {
      record({ name, args });
      return result;
    };

  return {
    mailSearchMessages: stub('mailSearchMessages', []),
    mailFetchThread: stub('mailFetchThread', { threadId: 't-1', messages: [] }),
    mailDownloadAttachments: stub('mailDownloadAttachments', []),
    mailCreateDraft: stub('mailCreateDraft', { draftId: 'draft-1' }),
    performMailAction: stub('performMailAction', {
      status: 'succeeded',
      providerActionId: 'provider-1',
    }),
    documentExtractText: stub('documentExtractText', { text: '' }),
    documentExtractFields: stub('documentExtractFields', { fields: {} }),
    documentNormalizeValue: stub('documentNormalizeValue', { value: null }),
    browserOpen: stub('browserOpen', { ok: true }),
    browserExtractText: stub('browserExtractText', { text: '' }),
    browserDownload: stub('browserDownload', { storagePath: null }),
    browserScreenshot: stub('browserScreenshot', { storagePath: null }),
    recorderStartStep: async (...args: unknown[]): Promise<unknown> => {
      record({ name: 'recorderStartStep', args });
      stepCounter += 1;
      return { stepExecutionId: `step-${String(stepCounter)}` };
    },
    recorderCompleteStep: stub('recorderCompleteStep'),
    recorderFailStep: stub('recorderFailStep'),
    recorderAppendEvidence: stub('recorderAppendEvidence'),
    recordHumanDecisionRequest: stub('recordHumanDecisionRequest'),
  } as unknown as Activities;
}

export async function createHarness(): Promise<Harness> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const calls: ActivityCall[] = [];

  return {
    env,
    calls,
    names: () => calls.map((call) => call.name),
    countOf: (name) => calls.filter((call) => call.name === name).length,
    worker: async (overrides = {}) => {
      const base = defaultActivities((call) => calls.push(call));
      const activities = { ...base } as Record<string, unknown>;
      for (const [name, implementation] of Object.entries(overrides)) {
        activities[name] = async (...args: unknown[]): Promise<unknown> => {
          calls.push({ name, args });
          return (implementation as (...a: unknown[]) => unknown)(...args);
        };
      }
      queueCounter += 1;
      const taskQueue = `test-${String(queueCounter)}`;
      const options: WorkerOptions = {
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: WORKFLOWS_PATH,
        activities,
      };
      return { worker: await Worker.create(options), taskQueue };
    },
    shutdown: async () => {
      await env.teardown();
    },
  };
}

const PINNED = AGENT_REGISTRY['inbound-import-receiving'][1];

/** A well-formed workflow argument; every field is overridable per case. */
export function receivingInput(overrides: Partial<ReceivingInput> = {}): ReceivingInput {
  return {
    executionId: '00000000-0000-4000-8000-000000000001',
    agentId: '00000000-0000-4000-8000-000000000002',
    agentVersionId: '00000000-0000-4000-8000-000000000003',
    deploymentKey: 'inbound-import-receiving',
    versionNo: 1,
    // Read from the registry rather than written out: pinning is asserted by
    // `registry-bundle.test.ts`, and duplicating the literal here would make every case fail the
    // day the agent is finalized.
    specHash: PINNED.specHash,
    gitCommitSha: null,
    businessKey: 'MSKU1234565',
    capabilities: ['mail.read', 'mail.send', 'document.extract', 'human.handoff'],
    toolkitVersion: '20250101_00',
    operatorEmail: 'ops@example.com',
    maxConcurrency: 4,
    messageRefs: [],
    ...overrides,
  };
}

export function messageRef(providerMessageId: string, threadId = 'thread-1'): MessageRef {
  return {
    provider: 'mock',
    providerMessageId,
    threadId,
    receivedAt: '2026-01-01T00:00:00.000Z',
    subject: 'Arrival notice MSKU1234565',
    storagePath: null,
  };
}
