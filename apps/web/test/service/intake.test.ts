import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MessageRef } from '@meridian/core/schemas';
import { receivingWorkflowId } from '@meridian/core/temporal-contract';
import {
  intakeMessage,
  RECONCILE_MIN_AGE_MS,
  reconcileQueuedExecutions,
} from '@meridian/ops/intake';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@meridian/core/database';
import type { Client } from '@temporalio/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeAgent,
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
} from './helpers';

/**
 * Correlation intake with a business key present.
 *
 * The property under test is one workflow and one execution per live business key, held up against
 * everything that could produce two: a redelivered message, two intakes racing, a database write
 * that fails after Temporal already committed, and a late message arriving after the case closed.
 * Temporal is faked here because these are questions about ordering and bookkeeping, not about the
 * server; `apps/backend/test/signals.test.ts` asks the same questions of a real one.
 */

const EMAIL = 'intake-service@meridian.test';
const PASSWORD = 'meridian-test-password';

/**
 * A Temporal stand-in that behaves the way `signalWithStart` is specified to.
 *
 * Namely: a workflow ID that is live is signalled and keeps its run ID; a workflow ID whose run has
 * been closed starts a new run with a new ID. A mock that always returned a fresh run ID would make
 * the "second message joins the first run" assertion vacuous.
 */
function fakeTemporal(): {
  client: Client;
  starts: string[];
  signals: string[];
  runs: Map<string, string>;
  close(workflowId: string): void;
} {
  const runs = new Map<string, string>();
  const startedAt = new Map<string, Date>();
  const closed = new Set<string>();
  const starts: string[] = [];
  const signals: string[] = [];

  const signalWithStart = vi.fn(
    async (_type: string, options: { workflowId: string }): Promise<unknown> => {
      const { workflowId } = options;
      const live = runs.get(workflowId);
      if (live !== undefined && !closed.has(workflowId)) {
        signals.push(workflowId);
        return { workflowId, signaledRunId: live, firstExecutionRunId: live };
      }
      const runId = randomUUID();
      runs.set(workflowId, runId);
      startedAt.set(workflowId, new Date());
      closed.delete(workflowId);
      starts.push(workflowId);
      return { workflowId, signaledRunId: runId, firstExecutionRunId: runId };
    },
  );

  const client = {
    workflow: {
      signalWithStart,
      start: vi.fn(() => {
        throw new Error('intake must never call workflow.start');
      }),
      getHandle: vi.fn((workflowId: string) => ({
        workflowId,
        signal: vi.fn(async () => {
          signals.push(workflowId);
        }),
        terminate: vi.fn(async () => {
          closed.add(workflowId);
        }),
        // Shaped like the real thing in the two ways intake depends on. An unknown workflow id
        // raises `WorkflowNotFoundError` rather than answering `RUNNING` with a null run — the
        // ordinary first-message case reaches this call, and a double that reports a phantom run
        // would let intake wait for something that was never there. And a live run carries a
        // `startTime`, because the adoption grace period is measured from it.
        describe: vi.fn(async () => {
          const runId = runs.get(workflowId);
          if (runId === undefined) {
            const error = new Error(`workflow ${workflowId} not found`);
            error.name = 'WorkflowNotFoundError';
            throw error;
          }
          return {
            runId,
            status: { name: closed.has(workflowId) ? 'COMPLETED' : 'RUNNING' },
            startTime: startedAt.get(workflowId) ?? new Date(),
          };
        }),
      })),
    },
  } as unknown as Client;

  return { client, starts, signals, runs, close: (id) => closed.add(id) };
}

function messageRef(businessKey: string, id = randomUUID()): MessageRef {
  return {
    provider: 'gmail',
    providerMessageId: `<${id}@forwarder.example>`,
    threadId: `thread-${businessKey}`,
    subject: `Arrival notice ${businessKey}`,
    receivedAt: '2026-02-11T00:00:00.000Z',
    storagePath: null,
  };
}

/**
 * A container number no other test in this file, or any previous run of it, has used.
 *
 * The key is the workflow ID, so a reused key means joining a case some earlier test left running,
 * and the failure would look like the correlation logic misbehaving. The serial is drawn at random
 * and the check digit computed, because the extractor validates the digit rather than the shape.
 */
function nextKey(): string {
  const ownerCode = 'MSKU';
  const serial = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const body = `${ownerCode}${serial}`;

  // ISO 6346 assigns 10..38 to A..Z, skipping every multiple of 11.
  const letterValues = new Map<string, number>();
  let value = 10;
  for (let index = 0; index < 26; index += 1) {
    if (value % 11 === 0) value += 1;
    letterValues.set(String.fromCharCode(65 + index), value);
    value += 1;
  }

  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const character = body[index] as string;
    sum +=
      (/\d/.test(character) ? Number(character) : (letterValues.get(character) ?? 0)) * 2 ** index;
  }
  const checkDigit = sum % 11 === 10 ? 0 : sum % 11;
  return `${body}${String(checkDigit)}`;
}

let service: SupabaseClient<Database>;
let agentId: string;

beforeAll(async () => {
  service = serviceClient();
  const ownerId = await ensureUser(EMAIL, PASSWORD);
  const operator = await userClient(EMAIL, PASSWORD);
  const board = await createBoard(operator);
  const { specId, specHash } = await freezeBoard(service, ownerId, board.whiteboardId);
  ({ agentId } = await activeAgent(
    service,
    operator,
    ownerId,
    board.whiteboardId,
    specId,
    specHash,
  ));
});

async function intake(
  temporal: Client,
  businessKey: string,
  ref = messageRef(businessKey),
  overrides: { supabase?: SupabaseClient<Database> } = {},
) {
  return intakeMessage({ supabase: overrides.supabase ?? service, temporal }, agentId, {
    messageRef: ref,
    content: {
      subject: ref.subject,
      body: `Container ${businessKey} arrives Thursday. Documents attached.`,
    },
  });
}

async function executionsFor(workflowId: string) {
  const { data } = await service
    .from('executions')
    .select(
      'execution_id, status, business_key, temporal_workflow_id, temporal_run_id, input_ref_json',
    )
    .eq('temporal_workflow_id', workflowId)
    .order('created_at');
  return data ?? [];
}

describe('a message carrying a business key', () => {
  it('starts exactly one workflow and one execution', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const result = await intake(temporal.client, key);

    expect(result.action).toBe('started');
    if (result.action === 'manual_review') throw new Error('unreachable');
    expect(result.businessKey).toBe(key);
    expect(result.temporalWorkflowId).toBe(receivingWorkflowId(key));
    expect(temporal.starts).toEqual([receivingWorkflowId(key)]);
    expect(temporal.signals).toEqual([]);

    const rows = await executionsFor(result.temporalWorkflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.temporal_run_id).toBe(result.temporalRunId);
  });

  it('derives the workflow ID before Temporal is called, not from its answer', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const result = await intake(temporal.client, key);
    if (result.action === 'manual_review') throw new Error('unreachable');
    // The ID is a pure function of the key, which is what makes step 6 atomic: there is nothing to
    // learn from Temporal that the row did not already know.
    expect(result.temporalWorkflowId).toBe(receivingWorkflowId(result.businessKey));
  });
});

describe('a second message on the same key', () => {
  it('signals the running workflow instead of starting another', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const first = await intake(temporal.client, key);
    const second = await intake(temporal.client, key);
    if (first.action === 'manual_review' || second.action === 'manual_review') {
      throw new Error('unreachable');
    }

    expect(second.action).toBe('signalled');
    expect(second.temporalRunId).toBe(first.temporalRunId);
    expect(temporal.starts).toHaveLength(1);
    expect(temporal.signals).toHaveLength(1);

    // One workflow, and the follow-up joins the same case rather than opening a second.
    expect(await executionsFor(first.temporalWorkflowId)).toHaveLength(1);
  });

  it('reuses the same execution when the very same message is redelivered', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const ref = messageRef(key);
    const first = await intake(temporal.client, key, ref);
    const second = await intake(temporal.client, key, ref);

    expect(second.executionId).toBe(first.executionId);
    expect(second.wasExisting).toBe(true);
  });
});

describe('two intakes racing on one key', () => {
  it('produces one execution and one workflow, and the loser signals', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const [a, b] = await Promise.all([
      intake(temporal.client, key, messageRef(key)),
      intake(temporal.client, key, messageRef(key)),
    ]);
    if (a.action === 'manual_review' || b.action === 'manual_review') {
      throw new Error('unreachable');
    }

    // `uq_executions_active_workflow` is what settles this, not the order the two happened to run.
    const rows = await executionsFor(receivingWorkflowId(key));
    expect(rows).toHaveLength(1);
    expect(temporal.starts).toHaveLength(1);
    expect(a.executionId).toBe(b.executionId);
  });
});

describe('a database write that fails after Temporal has committed', () => {
  it('leaves a queued row the sweeper reattaches, and starts no second workflow', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();

    // `start_execution` is the step that records the run ID. Failing it simulates the one ordering
    // that could lose track of a live workflow, and the recovery has to be the sweeper rather than
    // a retry of intake, which would call Temporal again.
    const failing = new Proxy(service, {
      get(target, prop, receiver) {
        if (prop !== 'rpc') return Reflect.get(target, prop, receiver) as unknown;
        return async (name: string, args: unknown) => {
          if (name === 'start_execution') return { data: null, error: { message: 'injected' } };
          return (target.rpc as (n: string, a: unknown) => unknown)(name, args);
        };
      },
    });

    await expect(
      intake(temporal.client, key, messageRef(key), { supabase: failing }),
    ).rejects.toThrow(/INTAKE_DB_UPDATE_FAILED/);

    const before = await executionsFor(receivingWorkflowId(key));
    expect(before).toHaveLength(1);
    expect(before[0]?.status).toBe('queued');

    // The sweep ignores rows younger than a minute, since those are still plausibly mid-intake.
    // Moving its clock forward is how this test reaches the branch without waiting.
    const reconciled = await reconcileQueuedExecutions({
      supabase: service,
      temporal: temporal.client,
      now: () => Date.now() + RECONCILE_MIN_AGE_MS * 2,
    });
    const mine = reconciled.filter((outcome) => outcome.workflowId === receivingWorkflowId(key));
    expect(mine.map((outcome) => outcome.action)).toEqual(['started']);

    const after = await executionsFor(receivingWorkflowId(key));
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.temporal_run_id).not.toBeNull();
    // The sweeper reattaches; it never starts anything.
    expect(temporal.starts).toHaveLength(1);
  });
});

describe('a late message after the case has closed', () => {
  it('opens a new linked run rather than reviving the finished one', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const first = await intake(temporal.client, key);
    if (first.action === 'manual_review') throw new Error('unreachable');

    const { error } = await service.rpc('complete_execution', {
      p_execution_id: first.executionId,
      p_status: 'passed',
      p_output_summary: { outcome: 'ready_to_receive' } as never,
      p_diff_summary: null as never,
    });
    expect(error).toBeNull();
    temporal.close(first.temporalWorkflowId);

    const late = await intake(temporal.client, key, messageRef(key));
    if (late.action === 'manual_review') throw new Error('unreachable');

    expect(late.executionId).not.toBe(first.executionId);
    expect(late.action).toBe('started');
    expect(late.temporalRunId).not.toBe(first.temporalRunId);

    const rows = await executionsFor(first.temporalWorkflowId);
    expect(rows).toHaveLength(2);
    // The new run knows which case it follows, so the history stays connected.
    const input = rows[1]?.input_ref_json as {
      previousExecutionId?: string;
      lateFollowUp?: boolean;
    };
    expect(input.previousExecutionId).toBe(first.executionId);
    expect(input.lateFollowUp).toBe(true);
  });

  it('treats a redelivery of the same message as already processed', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const ref = messageRef(key);
    const first = await intake(temporal.client, key, ref);
    if (first.action === 'manual_review') throw new Error('unreachable');

    await service.rpc('complete_execution', {
      p_execution_id: first.executionId,
      p_status: 'passed',
      p_output_summary: { outcome: 'ready_to_receive' } as never,
      p_diff_summary: null as never,
    });
    temporal.close(first.temporalWorkflowId);

    // The same provider message ID again — a redelivery, not a new document. The case key is
    // derived from that ID, so the row already exists and has already reported an outcome. Working
    // it a second time would re-send whatever the first run sent.
    const again = await intake(temporal.client, key, ref);
    if (again.action === 'manual_review') throw new Error('unreachable');

    expect(again.action).toBe('already_processed');
    expect(again.executionId).toBe(first.executionId);
    expect(temporal.starts).toHaveLength(1);
    expect(await executionsFor(first.temporalWorkflowId)).toHaveLength(1);
  });
});

describe('a run Temporal still has open after the row says it finished', () => {
  it('joins that run rather than writing a row no workflow will ever name', async () => {
    const temporal = fakeTemporal();
    const key = nextKey();
    const first = await intake(temporal.client, key);
    if (first.action === 'manual_review') throw new Error('unreachable');

    // The gap this closes: the workflow has written its terminal status but its run has not yet
    // closed. Reading only the row, intake would call this a late follow-up, write a second row,
    // and hand the message to `signalWithStart` — which, finding the run open, would deliver it to
    // a workflow carrying the first execution ID and strand the row it just wrote in `running`.
    await service.rpc('complete_execution', {
      p_execution_id: first.executionId,
      p_status: 'passed',
      p_output_summary: { outcome: 'ready_to_receive' } as never,
      p_diff_summary: null as never,
    });

    const second = await intake(temporal.client, key, messageRef(key));
    if (second.action === 'manual_review') throw new Error('unreachable');

    expect(second.action).toBe('signalled');
    expect(second.executionId).toBe(first.executionId);
    expect(temporal.starts).toHaveLength(1);
    expect(await executionsFor(first.temporalWorkflowId)).toHaveLength(1);
  });
});

describe('the intake path itself', () => {
  it('never calls workflow.start', () => {
    // A24. `signalWithStart` is one atomic server-side operation; `start` plus a catch is a race
    // with an error used as control flow. A grep is the only check that survives refactoring.
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/ops/src/intake/index.ts', import.meta.url)),
      'utf8',
    );
    const signalSource = readFileSync(
      fileURLToPath(
        new URL('../../../../packages/ops/src/intake/signal-with-start.ts', import.meta.url),
      ),
      'utf8',
    );
    // Comments are stripped first: both files discuss the forbidden approach in order to explain
    // why it is not used, and a grep that could not tell prose from code would forbid saying so.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const text of [source, signalSource]) {
      expect(code(text)).not.toContain('workflow.start(');
      expect(code(text)).not.toContain('WorkflowExecutionAlreadyStartedError');
    }
  });

  it('refuses to run an agent that has no active release', async () => {
    const temporal = fakeTemporal();
    const ownerId = await ensureUser(EMAIL, PASSWORD);
    const operator = await userClient(EMAIL, PASSWORD);
    const board = await createBoard(operator);
    const { data } = await operator.rpc('create_agent', {
      p_whiteboard_id: board.whiteboardId,
      p_deployment_key: `intake-idle-${randomUUID().slice(0, 8)}`,
      p_name: 'Never activated',
    });
    const idleAgentId = (data as unknown as { agentId: string }).agentId;
    expect(ownerId).toBeTruthy();

    await expect(
      intakeMessage({ supabase: service, temporal: temporal.client }, idleAgentId, {
        messageRef: messageRef('MSKU1234565'),
        content: { subject: 'x', body: 'Container MSKU1234565 arrives Thursday.' },
      }),
    ).rejects.toThrow(/no active version/);
    expect(temporal.starts).toEqual([]);
  });
});
