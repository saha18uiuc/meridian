import { chunk } from '@meridian/agent-kit/contracts';
import { describe, expect, it } from 'vitest';
import {
  BATCH_BASE,
  INVOICE_BASE,
  INVOICE_STRIDE,
  planSequences,
  STAGE_ORDINALS,
} from '../src/temporal/workflows/sequence-plan.js';

const invoices = [
  { invoiceNumber: 'INV-1024', lineKeys: ['line-2', 'line-1'] },
  { invoiceNumber: 'INV-1007', lineKeys: ['line-3'] },
];
const batchNumbers = ['B-77', 'B-12'];

describe('planSequences', () => {
  it('assigns ordinals from sorted keys, not from insertion order', () => {
    const plan = planSequences({ invoices, batchNumbers });
    // INV-1007 sorts first even though it was supplied second.
    expect(plan.invoice('INV-1007')).toBe(INVOICE_BASE);
    expect(plan.invoice('INV-1024')).toBe(INVOICE_BASE + INVOICE_STRIDE);
    expect(plan.good('INV-1024', 'line-1')).toBe(INVOICE_BASE + INVOICE_STRIDE + 1);
    expect(plan.good('INV-1024', 'line-2')).toBe(INVOICE_BASE + INVOICE_STRIDE + 2);
    expect(plan.batch('B-12')).toBe(BATCH_BASE);
    expect(plan.batch('B-77')).toBe(BATCH_BASE + 1);
  });

  it('is unchanged by shuffling the input', () => {
    const forward = planSequences({ invoices, batchNumbers });
    const shuffled = planSequences({
      invoices: [
        { invoiceNumber: 'INV-1024', lineKeys: ['line-1', 'line-2'] },
        { invoiceNumber: 'INV-1007', lineKeys: ['line-3'] },
      ].reverse(),
      batchNumbers: [...batchNumbers].reverse(),
    });
    expect(shuffled.goods()).toEqual(forward.goods());
    expect(shuffled.batch('B-12')).toBe(forward.batch('B-12'));
  });

  it('gives every stage a fixed ordinal so the step list reads in a sensible order', () => {
    const plan = planSequences({ invoices: [], batchNumbers: [] });
    expect(plan.stage('intake')).toBeLessThan(plan.stage('correlate'));
    expect(plan.stage('decide')).toBeLessThan(plan.stage('respond'));
    expect(plan.stage('respond')).toBe(STAGE_ORDINALS.respond);
  });

  it('refuses to invent an ordinal for a key that was never planned', () => {
    const plan = planSequences({ invoices, batchNumbers });
    expect(() => plan.invoice('INV-9999')).toThrow(/No sequence ordinal was planned/);
    expect(() => plan.good('INV-1024', 'line-9')).toThrow(/good/);
  });

  it('lets parallel branches legitimately share an ordinal without colliding on identity', () => {
    // `sequence_no` is display ordering only, so two goods in different invoices may share one.
    // Identity is `step_instance_key`, which is derived from the business keys instead.
    const plan = planSequences({
      invoices: [
        { invoiceNumber: 'INV-1', lineKeys: ['a'] },
        { invoiceNumber: 'INV-2', lineKeys: ['a'] },
      ],
      batchNumbers: [],
    });
    const instanceKeys = plan.goods().map((good) => `good:${good.invoiceNumber}:${good.lineKey}`);
    expect(new Set(instanceKeys).size).toBe(2);
  });
});

describe('chunked fan-out', () => {
  it('produces stable batches of five from the planned order', () => {
    const plan = planSequences({
      invoices: [{ invoiceNumber: 'INV-1', lineKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
      batchNumbers: [],
    });
    const batches = chunk(plan.goods(), 5);
    expect(batches.map((batch) => batch.length)).toEqual([5, 2]);
    // Deterministic membership is the property `p-limit` cannot offer: its scheduling depends on
    // promise resolution order, which a Temporal replay does not reproduce.
    expect(batches[0]?.map((good) => good.lineKey)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
