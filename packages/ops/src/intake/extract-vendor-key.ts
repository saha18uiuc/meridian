import type { BusinessKeyResult, ExtractionSource } from './extract-business-key.js';

/**
 * Correlation for the vendor renewal deployment.
 *
 * Its existence is the point. Correlation looked generic while there was one deployment, because
 * "the business key" and "an ISO 6346 container number or an IATA air waybill" were the same
 * sentence. They are not: what identifies a unit of work is the process's own question, and this
 * one answers it with a vendor account number. Intake therefore takes an extractor rather than
 * containing one, and each deployment names its own in `deployments.ts`.
 *
 * The shape is deliberately identical to the shipment extractor's, including reporting a conflict
 * rather than picking, because refusing to guess is a platform property and not a domain one.
 */

const VENDOR_PATTERN = /\bVEND-(\d{4,6})\b/g;

function scan(text: string, source: 'subject' | 'body' | 'attachment'): string[] {
  return [...text.toUpperCase().matchAll(VENDOR_PATTERN)].map((match) => {
    void source;
    return `VEND-${match[1] ?? ''}`;
  });
}

export function extractVendorAccount(source: ExtractionSource): BusinessKeyResult {
  const found = [
    ...scan(source.subject ?? '', 'subject'),
    ...scan(source.body ?? '', 'body'),
    ...scan(JSON.stringify(source.attachmentFields ?? {}), 'attachment'),
  ];
  if (found.length === 0) return { kind: 'none', candidates: [] };

  const distinct = [...new Set(found)].sort();
  const candidates = distinct.map((value) => ({
    kind: 'vendor' as const,
    value,
    source: 'subject' as const,
  }));

  // Two vendor accounts on one thread is a message about two relationships. Merging them would
  // attach one vendor's certificate to the other's renewal.
  if (distinct.length > 1) return { kind: 'conflict', candidates };
  return {
    kind: 'ok',
    businessKey: distinct[0] as string,
    keyKind: 'vendor',
    candidates,
  };
}
