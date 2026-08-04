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

/**
 * The discrepancy report the SOP asks for: "Any missing information or documentation must be
 * reported via email with the Invoice Number, Batch Number(s) and description of discrepancy."
 *
 * The three required details are already carried by each failure's message, which is why this
 * function only orders and frames them. Re-deriving them here would give the report a second
 * opinion about what is wrong with the shipment.
 */
export function missingInformationBody(
  businessKey: string,
  failures: readonly ValidationFailure[],
): string {
  const lines = [...failures].map(describe).sort();
  return [
    `Pre-alert validation for ${businessKey} found the following discrepancies:`,
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

/**
 * The two schemas this version extracts against. There is deliberately no packing-list schema: the
 * SOP validates the Commercial Invoice and the Certificates of Analysis and never reads a packing
 * list, so a schema for one would be a capability nothing on the board asked for.
 */
export const EXTRACTION_SCHEMA_INVOICE = 'invoice';
export const EXTRACTION_SCHEMA_COA = 'coa';
