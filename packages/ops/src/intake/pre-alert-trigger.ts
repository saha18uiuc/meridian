/**
 * The subject-line trigger the SOP defines.
 *
 * "Pre-Alert Emails are sent to a pre-defined email group for which the bot will be given access
 * to. Email Subject contains one of the following: 'Pre-Alert Documents', 'APL USA // PRE-ALERT
 * DOCUMENTATION'."
 *
 * This is scope, not correlation, and the difference matters. A message that fails this test is not
 * a shipment the process could not understand; it is a message the process was never asked to look
 * at. Routing it to manual review would fill the queue with the rest of the mailbox, so intake
 * declines it and records nothing.
 *
 * Matching is deliberately loose about case and internal whitespace and deliberately strict about
 * the phrase itself. Forwarders prepend `RE:`, `FW:`, and ticket numbers, and mail clients rewrap
 * long subjects; none of that changes whether the phrase is present. Matching on a looser token
 * like "pre-alert" alone would pull in the reply to a query about a pre-alert, which is a different
 * thing.
 */

export const PRE_ALERT_SUBJECTS = [
  'Pre-Alert Documents',
  'APL USA // PRE-ALERT DOCUMENTATION',
] as const;

/** Case, separator, and whitespace differences are noise; the phrase is the signal. */
function normalize(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

export function isPreAlertSubject(subject: string | null | undefined): boolean {
  if (typeof subject !== 'string') return false;
  const normalized = normalize(subject);
  return PRE_ALERT_SUBJECTS.some((phrase) => normalized.includes(normalize(phrase)));
}
