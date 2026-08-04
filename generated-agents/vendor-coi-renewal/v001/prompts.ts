import type { CertificateFinding } from './rules.js';

/**
 * The wording of everything this version sends or asks.
 *
 * Kept out of `agent.ts` for the same reason as in every other deployment: a wording change should
 * be visibly a wording change in review, and a prompt should not be able to introduce a decision.
 * Every string is a pure function of already-decided facts — no clock, no locale, nothing unsorted.
 */

export const CORRECTION_SUBJECT_PREFIX = 'Certificate of Insurance needs correcting';

export function correctionSubject(vendorId: string): string {
  return `${CORRECTION_SUBJECT_PREFIX} — ${vendorId}`;
}

export function correctionBody(vendorId: string, findings: readonly CertificateFinding[]): string {
  const lines = [...findings].map((finding) => `- ${finding.message}`).sort();
  return [
    `We cannot record a renewal for ${vendorId} until the following is resolved:`,
    '',
    ...lines,
    '',
    'Please reply on this thread with a corrected certificate.',
  ].join('\n');
}

export function handoffQuestion(vendorId: string, reason: string): string {
  return `The insurance renewal for ${vendorId} stopped because ${reason}. How should this vendor be handled?`;
}

/** The one schema this version extracts against. */
export const EXTRACTION_SCHEMA_CERTIFICATE = 'certificateOfInsurance';
