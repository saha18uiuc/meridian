/**
 * Business-key extraction (§5.11 step 2).
 *
 * This runs entirely outside Temporal, before any workflow exists, because the workflow ID is
 * derived from the key: a key discovered inside the workflow would already be too late to choose
 * the workflow that should have received it.
 *
 * Both formats are validated by their check digit, not merely by shape. A regex alone matches
 * things like invoice numbers and tracking codes that happen to look like a container number, and
 * correlating two unrelated shipments is a far worse failure than sending one message to manual
 * review.
 */

/**
 * What kind of identifier a business key is. Deployments contribute their own: `vendor` belongs to
 * the renewal example, not to the importer's, and neither belongs to the platform.
 */
export type BusinessKeyKind = 'container' | 'mawb' | 'invoice' | 'vendor';

export interface BusinessKeyCandidate {
  kind: BusinessKeyKind;
  value: string;
  /** Where it was found, kept for the manual-review evidence payload. */
  source: 'subject' | 'body' | 'attachment';
}

export type BusinessKeyResult =
  | {
      kind: 'ok';
      businessKey: string;
      keyKind: BusinessKeyKind;
      candidates: BusinessKeyCandidate[];
    }
  | { kind: 'none'; candidates: [] }
  | { kind: 'conflict'; candidates: BusinessKeyCandidate[] };

export interface ExtractionSource {
  subject?: string | null;
  body?: string | null;
  /** Already-extracted attachment fields, flattened to strings by the caller. */
  attachmentFields?: Record<string, unknown> | null;
}

// Container numbers are written every possible way in practice: `MSCU 123456-7`, `mscu1234567`,
// `MSCU-123456 7`. Separators are stripped before validation rather than being enumerated here.
const CONTAINER_PATTERN = /\b([A-Z]{3}[UJZ])[\s-]?(\d{6})[\s-]?(\d)\b/g;

// IATA air waybills are a three-digit airline prefix and an eight-digit serial whose last digit is
// the check digit: `020-12345675`, `020 1234567 5`, or unseparated.
const MAWB_PATTERN = /\b(\d{3})[\s-]?(\d{7})[\s-]?(\d)\b/g;

// The fallback. The SOP never names a container or a waybill: it identifies everything it reports
// by the invoice number in the top-right corner of the commercial invoice. So a pre-alert that
// carries no transport key is not necessarily uncorrelatable, and there is no check digit to lean
// on — the prefix is doing all the work, which is why this is only ever consulted second.
const INVOICE_PATTERN = /\bINV[\s-]?(\d{3,8})\b/g;

const OWNER_CODE_WEIGHTS = new Map<string, number>();
{
  // ISO 6346 assigns 10..38 to A..Z but skips every multiple of 11, which is why the table is
  // built rather than computed as a simple offset.
  let value = 10;
  for (let index = 0; index < 26; index += 1) {
    if (value % 11 === 0) value += 1;
    OWNER_CODE_WEIGHTS.set(String.fromCharCode(65 + index), value);
    value += 1;
  }
}

/** ISO 6346 check digit: weighted sum of the first ten characters, modulo 11, with 10 → 0. */
export function isValidContainerNumber(candidate: string): boolean {
  const normalized = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) return false;

  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const character = normalized[index] ?? '';
    const weight = /\d/.test(character)
      ? Number(character)
      : (OWNER_CODE_WEIGHTS.get(character) ?? 0);
    sum += weight * 2 ** index;
  }
  const expected = sum % 11 === 10 ? 0 : sum % 11;
  return expected === Number(normalized[10]);
}

/** IATA check digit: the seven-digit serial modulo 7. */
export function isValidMawb(candidate: string): boolean {
  const normalized = candidate.replace(/[^0-9]/g, '');
  if (!/^\d{11}$/.test(normalized)) return false;
  const serial = Number(normalized.slice(3, 10));
  return serial % 7 === Number(normalized[10]);
}

export function normalizeContainerNumber(candidate: string): string {
  return candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeMawb(candidate: string): string {
  const digits = candidate.replace(/[^0-9]/g, '');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function normalizeInvoiceNumber(candidate: string): string {
  return `INV-${candidate.replace(/[^0-9]/g, '')}`;
}

function scan(text: string, source: BusinessKeyCandidate['source']): BusinessKeyCandidate[] {
  const found: BusinessKeyCandidate[] = [];
  const upper = text.toUpperCase();

  for (const match of upper.matchAll(CONTAINER_PATTERN)) {
    const raw = `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}`;
    if (isValidContainerNumber(raw)) {
      found.push({ kind: 'container', value: normalizeContainerNumber(raw), source });
    }
  }

  for (const match of upper.matchAll(MAWB_PATTERN)) {
    const raw = `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}`;
    if (isValidMawb(raw)) {
      found.push({ kind: 'mawb', value: normalizeMawb(raw), source });
    }
  }

  return found;
}

function scanInvoices(
  text: string,
  source: BusinessKeyCandidate['source'],
): BusinessKeyCandidate[] {
  return [...text.toUpperCase().matchAll(INVOICE_PATTERN)].map((match) => ({
    kind: 'invoice' as const,
    value: normalizeInvoiceNumber(match[1] ?? ''),
    source,
  }));
}

function flattenFields(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .sort()
    .map((key) => {
      const value = fields[key];
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    })
    .filter((entry) => entry !== '')
    .join('\n');
}

export function extractBusinessKey(source: ExtractionSource): BusinessKeyResult {
  const texts: [string, BusinessKeyCandidate['source']][] = [
    [source.subject ?? '', 'subject'],
    [source.body ?? '', 'body'],
    [flattenFields(source.attachmentFields ?? {}), 'attachment'],
  ];

  const transport = texts.flatMap(([text, where]) => scan(text, where));

  // Strictly a fallback, never a tie-breaker. A pre-alert that names both a container and an
  // invoice is a container shipment; consulting the invoice as well would manufacture a conflict
  // out of two identifiers that agree about which shipment this is.
  const candidates =
    transport.length > 0 ? transport : texts.flatMap(([text, where]) => scanInvoices(text, where));

  if (candidates.length === 0) return { kind: 'none', candidates: [] };

  const distinct = [...new Set(candidates.map((candidate) => candidate.value))].sort();
  if (distinct.length > 1) {
    // Two different valid keys in one thread is exactly the case where guessing is unacceptable:
    // picking the first would attach a shipment's documents to a different shipment.
    return { kind: 'conflict', candidates: dedupe(candidates) };
  }

  const businessKey = distinct[0] ?? '';
  const keyKind =
    candidates.find((candidate) => candidate.value === businessKey)?.kind ?? 'container';
  return { kind: 'ok', businessKey, keyKind, candidates: dedupe(candidates) };
}

function dedupe(candidates: BusinessKeyCandidate[]): BusinessKeyCandidate[] {
  const seen = new Set<string>();
  const unique: BusinessKeyCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.value}|${candidate.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique.sort(
    (left, right) =>
      left.value.localeCompare(right.value) || left.source.localeCompare(right.source),
  );
}
