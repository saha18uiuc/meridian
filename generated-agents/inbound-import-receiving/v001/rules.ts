import type { Coa, Good, Invoice } from '@meridian/core/schemas';

/**
 * The policy the frozen specification states, expressed as pure functions.
 *
 * Everything here is total and side-effect free: the same shipment always produces the same
 * findings, in the same order, regardless of when or where it runs. That is what lets the eval
 * suite treat a changed result as a real regression rather than as scheduling noise.
 *
 * Nothing in this file invents policy. Where the specification is silent — what tolerance a
 * quantity mismatch has, whether a partial shipment may be received — the code does not guess; the
 * question surfaces as a `manual_review` outcome and, in the repair loop, as a policy gap.
 */

export interface ValidationFailure {
  scope: 'invoice' | 'good' | 'batch' | 'shipment';
  key: string;
  field: string;
  message: string;
}

/**
 * The customer's field policy, which lives here rather than in the shared skeleton.
 *
 * The SOP names four identifiers as the ones a good must carry before it can be received. It also
 * asks the reader to capture the FDA registration number, but never makes receiving contingent on
 * it. Those are two different obligations, so they are two different lists: the first decides an
 * outcome, the second only decides what gets written down. Collapsing them into one list is what
 * made an earlier version refuse shipments the SOP would have accepted.
 */
export const BLOCKING_GOOD_FIELDS = [
  'htsCode',
  'fdaProductCode',
  'andaNumber',
  'ndcNumber',
] as const satisfies readonly (keyof Good)[];

/** Extracted and reported, never a reason to stop. */
export const CAPTURED_GOOD_FIELDS = [
  'registrationNumber',
] as const satisfies readonly (keyof Good)[];

const FIELD_LABELS: Record<
  (typeof BLOCKING_GOOD_FIELDS)[number] | (typeof CAPTURED_GOOD_FIELDS)[number],
  string
> = {
  htsCode: 'HTS code',
  fdaProductCode: 'FDA product code',
  andaNumber: 'ANDA number',
  ndcNumber: 'NDC number',
  registrationNumber: 'FDA registration number',
};

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The three things the SOP requires an error to name: "log an error mentioning the Invoice Number
 * (top-right corner), Drug Description, and Missing Information Type."
 *
 * A line key is what the system uses to tell two goods apart; it is not what a receiving clerk
 * reads. The message is written for the clerk, and the line key stays in `key` for the machine.
 */
function reportLine(invoiceNumber: string, good: Good, missing: string): string {
  const description = present(good.description) ? good.description : good.lineKey;
  return `Invoice ${invoiceNumber}, ${description}: ${missing}.`;
}

/** The four blocking identifiers, checked per good. Missing fields are reported, never defaulted. */
export function missingRequiredFields(good: Good, invoiceNumber: string): ValidationFailure[] {
  return BLOCKING_GOOD_FIELDS.filter((field) => !present(good[field])).map((field) => ({
    scope: 'good' as const,
    key: good.lineKey,
    field,
    message: reportLine(invoiceNumber, good, `missing ${FIELD_LABELS[field]}`),
  }));
}

/**
 * Gaps in the captured-only fields. Shaped like a failure so it can be recorded and read the same
 * way, but kept out of `failures` so it can never reach `outcomeFor`.
 */
export function capturedFieldGaps(good: Good, invoiceNumber: string): ValidationFailure[] {
  return CAPTURED_GOOD_FIELDS.filter((field) => !present(good[field])).map((field) => ({
    scope: 'good' as const,
    key: good.lineKey,
    field,
    message: reportLine(
      invoiceNumber,
      good,
      `no ${FIELD_LABELS[field]} on file, which does not hold receiving`,
    ),
  }));
}

export function goodIsComplete(good: Good): boolean {
  // The invoice number only shapes the wording, so completeness does not need a real one.
  return missingRequiredFields(good, '').length === 0;
}

/**
 * Two invoices carrying the same number on one shipment are a duplicate, not two shipments.
 * The first occurrence in sorted order wins so that the choice does not depend on arrival order.
 */
export function duplicateInvoiceNumbers(invoices: readonly Invoice[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const invoice of [...invoices].sort((a, b) =>
    a.invoiceNumber.localeCompare(b.invoiceNumber),
  )) {
    if (seen.has(invoice.invoiceNumber)) duplicates.add(invoice.invoiceNumber);
    seen.add(invoice.invoiceNumber);
  }
  return [...duplicates].sort();
}

/** A batch appearing on more than one good is a duplicate batch across the shipment. */
export function duplicateBatchNumbers(invoices: readonly Invoice[]): string[] {
  const counts = new Map<string, number>();
  for (const invoice of invoices) {
    for (const good of invoice.goods) {
      if (!present(good.batchNumber)) continue;
      counts.set(good.batchNumber, (counts.get(good.batchNumber) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([batch]) => batch)
    .sort();
}

export function batchNumbersOf(invoices: readonly Invoice[]): string[] {
  const batches = new Set<string>();
  for (const invoice of invoices) {
    for (const good of invoice.goods) {
      if (present(good.batchNumber)) batches.add(good.batchNumber);
    }
  }
  return [...batches].sort();
}

export interface CoaMatch {
  /** Batches named on an invoice with no certificate at all. */
  missing: string[];
  /** Batches covered by more than one certificate, which is ambiguous rather than reassuring. */
  ambiguous: string[];
  /** Certificates naming a batch that appears on no invoice. */
  unexpected: string[];
}

/** Exactly one certificate per batch, in both directions. */
export function matchCoas(invoices: readonly Invoice[], coas: readonly Coa[]): CoaMatch {
  const batches = batchNumbersOf(invoices);
  const counts = new Map<string, number>();
  for (const coa of coas) counts.set(coa.batchNumber, (counts.get(coa.batchNumber) ?? 0) + 1);

  return {
    missing: batches.filter((batch) => (counts.get(batch) ?? 0) === 0),
    ambiguous: batches.filter((batch) => (counts.get(batch) ?? 0) > 1),
    unexpected: [...counts.keys()].filter((batch) => !batches.includes(batch)).sort(),
  };
}

/**
 * Which invoice named each batch.
 *
 * The SOP reports a certificate discrepancy by Batch Number *and* Invoice Number, so the batch
 * alone is not a sufficient report. The first invoice in sorted order wins, which only matters for
 * a batch on two invoices — and that case is already a `rejected` duplicate before any certificate
 * is considered.
 */
export function invoiceForBatch(invoices: readonly Invoice[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const invoice of [...invoices].sort((a, b) =>
    a.invoiceNumber.localeCompare(b.invoiceNumber),
  )) {
    for (const good of invoice.goods) {
      if (!present(good.batchNumber)) continue;
      if (!owner.has(good.batchNumber)) owner.set(good.batchNumber, invoice.invoiceNumber);
    }
  }
  return owner;
}

export function coaFailures(match: CoaMatch, owner: Map<string, string>): ValidationFailure[] {
  const named = (batch: string): string =>
    `Invoice ${owner.get(batch) ?? 'unknown'}, batch ${batch}`;
  return [
    ...match.missing.map((key) => ({
      scope: 'batch' as const,
      key,
      field: 'certificateOfAnalysis',
      message: `${named(key)}: no Certificate of Analysis was attached.`,
    })),
    ...match.ambiguous.map((key) => ({
      scope: 'batch' as const,
      key,
      field: 'certificateOfAnalysis',
      message: `${named(key)}: more than one Certificate of Analysis was attached.`,
    })),
    ...match.unexpected.map((key) => ({
      scope: 'batch' as const,
      key,
      field: 'certificateOfAnalysis',
      message: `Batch ${key}: a Certificate of Analysis was attached for a batch that appears on no invoice in this shipment.`,
    })),
  ];
}

/**
 * The human-readable list that goes into the information request.
 *
 * The strings are stable and sorted because they are asserted by the eval suite and because a
 * request whose wording shifts between runs is impossible to deduplicate against.
 */
export function missingInformationList(failures: readonly ValidationFailure[]): string[] {
  return [
    ...new Set(failures.map((failure) => `${failure.scope}:${failure.key}:${failure.field}`)),
  ].sort();
}

export interface ShipmentAssessment {
  failures: ValidationFailure[];
  /** Recorded and surfaced, but never an input to `outcomeFor`. */
  notes: ValidationFailure[];
  duplicateInvoices: string[];
  duplicateBatches: string[];
  coa: CoaMatch;
  goodsCount: number;
  validGoodsCount: number;
}

export function assessShipment(
  invoices: readonly Invoice[],
  coas: readonly Coa[],
): ShipmentAssessment {
  const goods = invoices.flatMap((invoice) => invoice.goods);
  const fieldFailures = invoices
    .flatMap((invoice) =>
      [...invoice.goods]
        .sort((a, b) => a.lineKey.localeCompare(b.lineKey))
        .flatMap((good) => missingRequiredFields(good, invoice.invoiceNumber)),
    )
    .sort((a, b) => `${a.key}:${a.field}`.localeCompare(`${b.key}:${b.field}`));

  const duplicateInvoices = duplicateInvoiceNumbers(invoices);
  const duplicateBatches = duplicateBatchNumbers(invoices);
  const coa = matchCoas(invoices, coas);

  const failures: ValidationFailure[] = [
    ...duplicateInvoices.map((key) => ({
      scope: 'invoice' as const,
      key,
      field: 'invoiceNumber',
      message: `Invoice ${key} appears more than once on this shipment.`,
    })),
    ...duplicateBatches.map((key) => ({
      scope: 'batch' as const,
      key,
      field: 'batchNumber',
      message: `Batch ${key} appears on more than one good in this shipment.`,
    })),
    ...fieldFailures,
    ...coaFailures(coa, invoiceForBatch(invoices)),
  ];

  const notes = invoices
    .flatMap((invoice) =>
      [...invoice.goods]
        .sort((a, b) => a.lineKey.localeCompare(b.lineKey))
        .flatMap((good) => capturedFieldGaps(good, invoice.invoiceNumber)),
    )
    .sort((a, b) => `${a.key}:${a.field}`.localeCompare(`${b.key}:${b.field}`));

  return {
    failures,
    notes,
    duplicateInvoices,
    duplicateBatches,
    coa,
    goodsCount: goods.length,
    validGoodsCount: goods.filter(goodIsComplete).length,
  };
}

/**
 * The outcome the specification assigns to an assessment.
 *
 * Duplicates are `rejected` because the specification says a shipment must not be received twice.
 * Missing fields and unmatched certificates are `needs_information` because the specification says
 * to ask the forwarder. Everything else clean is `ready`. There is no branch that guesses.
 */
export function outcomeFor(
  assessment: ShipmentAssessment,
): 'ready' | 'needs_information' | 'rejected' {
  if (assessment.duplicateInvoices.length > 0 || assessment.duplicateBatches.length > 0) {
    return 'rejected';
  }
  return assessment.failures.length === 0 ? 'ready' : 'needs_information';
}
