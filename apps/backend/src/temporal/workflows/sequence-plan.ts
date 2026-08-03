/**
 * Display ordinals, assigned before anything is scheduled.
 *
 * `sequence_no` exists only so a human reading the step list sees a sensible order. It is not an
 * identity and it is not unique — parallel siblings across different branches legitimately share
 * an ordinal. Assigning every ordinal up front from sorted business keys is what removes the need
 * for a runtime allocator, and a runtime allocator would be a coordination point that parallel
 * activities would have to serialise on.
 *
 * The function is pure: no clock, no randomness, no I/O. It is therefore safe inside the workflow
 * sandbox and reproduces identically on replay.
 */

export const STAGE_ORDINALS = {
  intake: 1,
  correlate: 2,
  extractInvoices: 10,
  extractCoas: 20,
  matchCoas: 30,
  decide: 40,
  respond: 90,
} as const;

export type StageName = keyof typeof STAGE_ORDINALS;

export interface SequencePlanInput {
  invoices: { invoiceNumber: string; lineKeys: string[] }[];
  batchNumbers: string[];
}

export interface SequencePlan {
  stage(name: StageName): number;
  invoice(invoiceNumber: string): number;
  good(invoiceNumber: string, lineKey: string): number;
  batch(batchNumber: string): number;
  /** Every planned good, in ordinal order; used to drive deterministic chunked fan-out. */
  goods(): { invoiceNumber: string; lineKey: string; sequenceNo: number }[];
}

export const INVOICE_BASE = 1000;
export const INVOICE_STRIDE = 100;
export const BATCH_BASE = 5000;

export function planSequences(input: SequencePlanInput): SequencePlan {
  const invoiceOrdinals = new Map<string, number>();
  const goodOrdinals = new Map<string, number>();
  const batchOrdinals = new Map<string, number>();
  const goods: { invoiceNumber: string; lineKey: string; sequenceNo: number }[] = [];

  const sortedInvoices = [...input.invoices].sort((left, right) =>
    left.invoiceNumber.localeCompare(right.invoiceNumber),
  );

  sortedInvoices.forEach((invoice, index) => {
    const base = INVOICE_BASE + index * INVOICE_STRIDE;
    invoiceOrdinals.set(invoice.invoiceNumber, base);
    const sortedLines = [...invoice.lineKeys].sort((left, right) => left.localeCompare(right));
    sortedLines.forEach((lineKey, lineIndex) => {
      const sequenceNo = base + 1 + lineIndex;
      goodOrdinals.set(`${invoice.invoiceNumber}\u0000${lineKey}`, sequenceNo);
      goods.push({ invoiceNumber: invoice.invoiceNumber, lineKey, sequenceNo });
    });
  });

  [...input.batchNumbers]
    .sort((left, right) => left.localeCompare(right))
    .forEach((batchNumber, index) => {
      batchOrdinals.set(batchNumber, BATCH_BASE + index);
    });

  function required(map: Map<string, number>, key: string, what: string): number {
    const value = map.get(key);
    if (value === undefined) {
      // Silently returning 0 would produce a plausible-looking plan for a key that was never part
      // of it, which is precisely the class of bug this planner exists to make impossible.
      throw new Error(`No sequence ordinal was planned for ${what} '${key}'.`);
    }
    return value;
  }

  return {
    stage: (name) => STAGE_ORDINALS[name],
    invoice: (invoiceNumber) => required(invoiceOrdinals, invoiceNumber, 'invoice'),
    good: (invoiceNumber, lineKey) =>
      required(goodOrdinals, `${invoiceNumber}\u0000${lineKey}`, 'good'),
    batch: (batchNumber) => required(batchOrdinals, batchNumber, 'batch'),
    goods: () => goods.map((entry) => ({ ...entry })),
  };
}
