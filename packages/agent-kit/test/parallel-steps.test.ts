import { beforeEach, describe, expect, it } from 'vitest';
import { chunk } from '../src/chunk.js';
import { createExecutionRecorder } from '../src/recording/recorder.js';
import { createFakeDb, createFakeSupabase, type FakeDb } from './helpers/fake-supabase.js';

const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Sequence numbers are assigned by the workflow before anything is scheduled, from sorted business
 * keys. These tests pin that arithmetic, because it is the reason no runtime allocator — and
 * therefore no coordination point — is needed under parallelism.
 */
function planSequences(invoices: { invoiceNumber: string; lineKeys: string[] }[]) {
  const sortedInvoices = [...invoices].sort((left, right) =>
    left.invoiceNumber.localeCompare(right.invoiceNumber),
  );
  return sortedInvoices.flatMap((invoice, invoiceIndex) => {
    const base = 1000 + invoiceIndex * 100;
    const sortedLines = [...invoice.lineKeys].sort((left, right) => left.localeCompare(right));
    return [
      {
        stepInstanceKey: `extract:${invoice.invoiceNumber}`,
        sequenceNo: base,
      },
      ...sortedLines.map((lineKey, lineIndex) => ({
        stepInstanceKey: `validate-good:${invoice.invoiceNumber}:${lineKey}`,
        sequenceNo: base + 1 + lineIndex,
      })),
    ];
  });
}

let db: FakeDb;
let recorder: ReturnType<typeof createExecutionRecorder>;

beforeEach(() => {
  db = createFakeDb();
  recorder = createExecutionRecorder(createFakeSupabase(db), { executionId: EXECUTION_ID });
});

describe('deterministic sequence planning', () => {
  it('assigns the same ordinals regardless of the order the invoices arrived in', () => {
    const forward = planSequences([
      { invoiceNumber: 'INV-1024', lineKeys: ['LINE-2', 'LINE-1'] },
      { invoiceNumber: 'INV-1025', lineKeys: ['LINE-1'] },
    ]);
    const reversed = planSequences([
      { invoiceNumber: 'INV-1025', lineKeys: ['LINE-1'] },
      { invoiceNumber: 'INV-1024', lineKeys: ['LINE-1', 'LINE-2'] },
    ]);
    expect(forward).toEqual(reversed);
  });

  it('gives invoice i the base 1000 + i*100 and its goods the following ordinals', () => {
    const plan = planSequences([
      { invoiceNumber: 'INV-1024', lineKeys: ['LINE-1', 'LINE-2'] },
      { invoiceNumber: 'INV-1025', lineKeys: ['LINE-1'] },
    ]);
    expect(plan).toEqual([
      { stepInstanceKey: 'extract:INV-1024', sequenceNo: 1000 },
      { stepInstanceKey: 'validate-good:INV-1024:LINE-1', sequenceNo: 1001 },
      { stepInstanceKey: 'validate-good:INV-1024:LINE-2', sequenceNo: 1002 },
      { stepInstanceKey: 'extract:INV-1025', sequenceNo: 1100 },
      { stepInstanceKey: 'validate-good:INV-1025:LINE-1', sequenceNo: 1101 },
    ]);
  });
});

describe('parallel step recording', () => {
  it('records every planned step exactly once with the planned ordinal', async () => {
    const plan = planSequences([
      { invoiceNumber: 'INV-1024', lineKeys: ['LINE-1', 'LINE-2', 'LINE-3'] },
    ]);
    for (const group of chunk(plan, 2)) {
      await Promise.all(
        group.map((entry) =>
          recorder.startStep({
            nodeId: null,
            stepKey: 'validate_invoice_good',
            stepInstanceKey: entry.stepInstanceKey,
            sequenceNo: entry.sequenceNo,
            attemptNo: 1,
          }),
        ),
      );
    }
    const rows = db.tables.execution_steps ?? [];
    expect(rows).toHaveLength(plan.length);
    expect(rows.map((row) => row.sequence_no)).toEqual(plan.map((entry) => entry.sequenceNo));
  });

  it('keeps distinct instances apart even when they share an ordinal', async () => {
    await Promise.all(
      ['validate:A', 'validate:B'].map((stepInstanceKey) =>
        recorder.startStep({
          nodeId: null,
          stepKey: 'validate_invoice_good',
          stepInstanceKey,
          sequenceNo: 1001,
          attemptNo: 1,
        }),
      ),
    );
    const rows = db.tables.execution_steps ?? [];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sequence_no)).size).toBe(1);
  });

  it('chunks a sorted plan into deterministic groups', () => {
    const plan = planSequences([{ invoiceNumber: 'INV-1024', lineKeys: ['L1', 'L2', 'L3', 'L4'] }]);
    expect(chunk(plan, 2).map((group) => group.map((entry) => entry.sequenceNo))).toEqual([
      [1000, 1001],
      [1002, 1003],
      [1004],
    ]);
  });
});
