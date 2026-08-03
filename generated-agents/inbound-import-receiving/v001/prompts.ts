import type { ValidationFailure } from './rules.js';

/**
 * The wording of everything this version sends or asks.
 *
 * Kept out of `agent.ts` so a wording change is visibly a wording change in review, and written as
 * pure functions of already-decided facts so no prompt can introduce a decision of its own. Every
 * string is deterministic: no clock, no locale, no interpolation of anything unsorted.
 */

export const MISSING_INFORMATION_SUBJECT_PREFIX = 'Information needed to receive';

export function missingInformationSubject(businessKey: string): string {
  return `${MISSING_INFORMATION_SUBJECT_PREFIX} ${businessKey}`;
}

function describe(failure: ValidationFailure): string {
  return `- ${failure.message}`;
}

export function missingInformationBody(
  businessKey: string,
  failures: readonly ValidationFailure[],
): string {
  const lines = [...failures].map(describe).sort();
  return [
    `We cannot complete receiving for ${businessKey} until the following is resolved:`,
    '',
    ...lines,
    '',
    'Please reply on this thread with the corrected documents.',
  ].join('\n');
}

/**
 * The question a specialist is asked when the process reaches a state the specification does not
 * decide. It names the reason rather than proposing an answer, because proposing one would be the
 * agent inventing the policy it just admitted it lacks.
 */
export function handoffQuestion(businessKey: string, reason: string): string {
  return `Receiving for ${businessKey} stopped because ${reason}. How should this shipment be handled?`;
}

export const EXTRACTION_SCHEMA_INVOICE = 'invoice';
export const EXTRACTION_SCHEMA_PACKING_LIST = 'packingList';
export const EXTRACTION_SCHEMA_COA = 'coa';
