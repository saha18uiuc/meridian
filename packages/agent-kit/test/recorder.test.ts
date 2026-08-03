import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionRecorder } from '../src/recording/recorder.js';
import { deriveActionKey } from '../src/idempotency.js';
import { createFakeDb, createFakeSupabase, type FakeDb } from './helpers/fake-supabase.js';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';

let db: FakeDb;
let recorder: ReturnType<typeof createExecutionRecorder>;

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_action_id: 'action-1',
    execution_id: EXECUTION_ID,
    step_execution_id: 'step-0001',
    action_type: 'mail.send',
    status: 'reserved',
    idempotency_key: 'k'.repeat(64),
    marker_token: 'kkkkkkkkkkkk',
    provider_action_id: null,
    request_payload_json: {},
    provider_response_json: null,
    reconciliation_json: null,
    attempt_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    dispatched_at: null,
    completed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createFakeDb();
  db.rpcHandlers.reserve_execution_action = (args, database) => {
    const row = action({
      idempotency_key: args.p_idempotency_key,
      marker_token: String(args.p_idempotency_key).slice(0, 12),
    });
    database.tables.execution_actions?.push(row);
    return { executionActionId: 'action-1', status: 'reserved' };
  };
  db.rpcHandlers.dispatch_execution_action = (_args, database) => {
    const row = database.tables.execution_actions?.[0];
    if (row !== undefined) {
      row.status = 'dispatched';
      row.attempt_count = (row.attempt_count as number) + 1;
      row.dispatched_at = '2026-01-01T00:01:00.000Z';
    }
    return { executionActionId: 'action-1', status: 'dispatched' };
  };
  db.rpcHandlers.complete_execution_action = (args, database) => {
    const row = database.tables.execution_actions?.[0];
    if (row !== undefined) {
      row.status = args.p_status;
      row.provider_action_id = args.p_provider_action_id;
      row.completed_at = '2026-01-01T00:02:00.000Z';
    }
    return { executionActionId: 'action-1', status: args.p_status };
  };
  db.rpcHandlers.mark_execution_action_for_reconciliation = (_args, database) => {
    const row = database.tables.execution_actions?.[0];
    if (row !== undefined) row.status = 'needs_reconciliation';
    return { executionActionId: 'action-1', status: 'needs_reconciliation' };
  };
  recorder = createExecutionRecorder(createFakeSupabase(db), { executionId: EXECUTION_ID });
});

describe('ExecutionRecorder steps', () => {
  it('uses the sequence number it was given and never allocates one', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'validate_invoice_good',
      stepInstanceKey: 'validate-good:INV-1024:LINE-1',
      sequenceNo: 1001,
      attemptNo: 1,
    });
    expect(step.sequenceNo).toBe(1001);
  });

  it('records three attempts of one instance as three rows sharing the instance key', async () => {
    for (const attemptNo of [1, 2, 3]) {
      await recorder.startStep({
        nodeId: null,
        stepKey: 'extract_invoice',
        stepInstanceKey: 'extract:INV-1024',
        sequenceNo: 10,
        attemptNo,
      });
    }
    const rows = db.tables.execution_steps ?? [];
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.step_instance_key)).size).toBe(1);
    expect(rows.map((row) => row.attempt_no)).toEqual([1, 2, 3]);
  });

  it('treats a duplicate attempt as a replay and returns the existing row', async () => {
    const first = await recorder.startStep({
      nodeId: null,
      stepKey: 'extract_invoice',
      stepInstanceKey: 'extract:INV-1024',
      sequenceNo: 10,
      attemptNo: 1,
    });
    const replay = await recorder.startStep({
      nodeId: null,
      stepKey: 'extract_invoice',
      stepInstanceKey: 'extract:INV-1024',
      sequenceNo: 10,
      attemptNo: 1,
    });
    expect(replay.stepExecutionId).toBe(first.stepExecutionId);
    expect(db.tables.execution_steps).toHaveLength(1);
  });

  it('lets parallel siblings share a sequence number', async () => {
    await recorder.startStep({
      nodeId: null,
      stepKey: 'validate_invoice_good',
      stepInstanceKey: 'validate:LINE-1',
      sequenceNo: 1001,
      attemptNo: 1,
    });
    await recorder.startStep({
      nodeId: null,
      stepKey: 'validate_invoice_good',
      stepInstanceKey: 'validate:LINE-2',
      sequenceNo: 1001,
      attemptNo: 1,
    });
    expect(db.tables.execution_steps).toHaveLength(2);
  });

  it('completes and fails a step with the terminal timestamps set', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'k',
      stepInstanceKey: 'i',
      sequenceNo: 1,
    });
    const done = await recorder.completeStep(step.stepExecutionId, { ok: true });
    expect(done.status).toBe('succeeded');
    expect(done.completedAt).not.toBeNull();

    const other = await recorder.startStep({
      nodeId: null,
      stepKey: 'k',
      stepInstanceKey: 'j',
      sequenceNo: 2,
    });
    const failed = await recorder.failStep(other.stepExecutionId, { code: 'BOOM' });
    expect(failed.status).toBe('failed');
    expect(failed.errorJson).toEqual({ code: 'BOOM' });
  });
});

describe('ExecutionRecorder evidence', () => {
  it('keeps a small payload inline', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'k',
      stepInstanceKey: 'i',
      sequenceNo: 1,
    });
    await recorder.appendEvidence(step.stepExecutionId, { note: 'small' }, { eventKey: 'e' });
    const event = (db.tables.execution_events ?? [])[0];
    expect(event?.storage_path).toBeNull();
    expect(event?.payload_json).toEqual({ note: 'small' });
  });

  it('offloads an oversize payload to Storage and stores only the path', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'k',
      stepInstanceKey: 'ocr:INV-1024',
      sequenceNo: 1,
    });
    await recorder.appendEvidence(step.stepExecutionId, { text: 'x'.repeat(40_000) });
    const event = (db.tables.execution_events ?? [])[0];
    expect(event?.storage_path).toMatch(
      /^ocr\/11111111-[0-9a-f-]+\/ocr:INV-1024\/evidence-[0-9a-f]{16}\.json$/,
    );
    expect(event?.payload_json).toEqual({ truncated: true, reason: 'PAYLOAD_MOVED_TO_STORAGE' });
    expect(Object.keys(db.storage)).toHaveLength(1);
  });
});

describe('ExecutionRecorder actions', () => {
  it('derives the reservation key from the step instance key, not the row id', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'send_response',
      stepInstanceKey: 'send:MSKU1234565',
      sequenceNo: 90,
    });
    const payload = { to: 'a@b.c', subject: 's' };
    await recorder.reserveAction(step.stepExecutionId, 'mail.send', payload);
    const call = db.rpcCalls.find((entry) => entry.name === 'reserve_execution_action');
    expect(call?.args.p_idempotency_key).toBe(
      deriveActionKey({
        executionId: EXECUTION_ID,
        stepInstanceKey: 'send:MSKU1234565',
        actionType: 'mail.send',
        payload,
      }),
    );
  });

  it('routes each lifecycle move through exactly one RPC and performs no local status arithmetic', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'send_response',
      stepInstanceKey: 'send:MSKU1234565',
      sequenceNo: 90,
    });
    await recorder.reserveAction(step.stepExecutionId, 'mail.send', { to: 'a@b.c' });
    await recorder.dispatchAction('action-1');
    await recorder.completeAction('action-1', { status: 'succeeded', providerActionId: 'm-1' });
    expect(db.rpcCalls.map((entry) => entry.name)).toEqual([
      'reserve_execution_action',
      'dispatch_execution_action',
      'complete_execution_action',
    ]);
  });

  it('increments attempt_count only on dispatch', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'send_response',
      stepInstanceKey: 'send:MSKU1234565',
      sequenceNo: 90,
    });
    const reserved = await recorder.reserveAction(step.stepExecutionId, 'mail.send', {});
    expect(reserved.attemptCount).toBe(0);
    const dispatched = await recorder.dispatchAction('action-1');
    expect(dispatched.attemptCount).toBe(1);
  });

  it('leaves completed_at null when an action is marked for reconciliation', async () => {
    const step = await recorder.startStep({
      nodeId: null,
      stepKey: 'send_response',
      stepInstanceKey: 'send:MSKU1234565',
      sequenceNo: 90,
    });
    await recorder.reserveAction(step.stepExecutionId, 'mail.send', {});
    const marked = await recorder.markActionForReconciliation('action-1', { code: 'TIMEOUT' });
    expect(marked.status).toBe('needs_reconciliation');
    expect(marked.completedAt).toBeNull();
  });
});

describe('recorder source', () => {
  it('never queries max(sequence_no)', () => {
    // Comments are stripped first: the prose in `steps.ts` names the forbidden call precisely
    // because it is forbidden, and matching that would defeat the check.
    const withoutComments = (path: string): string =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    expect(withoutComments('../src/recording/recorder.ts')).not.toMatch(/max\(/);
    expect(withoutComments('../src/recording/steps.ts')).not.toMatch(/max\(/);
  });
});
