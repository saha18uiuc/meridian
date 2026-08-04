import { readFileSync, writeFileSync } from 'node:fs';
import { repoPath } from '../lib/state.js';

/**
 * Projects the committed fixture mail into a constant the browser can read.
 *
 * The deployed web app has no filesystem and `examples/` is not in its bundle, so the trigger panel
 * cannot list the mail by reading the directory the way the worker does. Rather than hand-maintain a
 * second copy of the same facts, this derives one from the `.eml` files and writes it as source.
 *
 * Only a curated subset is projected. The eval suite is where breadth belongs; this list exists so
 * that somebody clicking through the deployed app can reach each distinct outcome on purpose, and a
 * dropdown with every fixture in it would make that harder rather than easier.
 */

const EMAIL_DIR = 'examples/inbound-import-receiving/fixtures/emails';
const OUTPUT = 'apps/web/src/features/executions/demo-mail.ts';

interface Pick {
  file: string;
  label: string;
  expectedOutcome: 'ready' | 'needs_information' | 'rejected' | 'manual_review' | 'completed';
  note: string;
}

/**
 * Ordered as a walkthrough rather than alphabetically: the clean case first, then the two that ask a
 * question, then the reply that answers one, then the edges. Somebody clicking top to bottom sees
 * the process explain itself.
 */
const PICKS: readonly Pick[] = [
  {
    file: 'happy-path.eml',
    label: 'Complete pre-alert',
    expectedOutcome: 'ready',
    note: 'Invoice and both certificates attached. Every required field is present, so the shipment receives.',
  },
  {
    file: 'missing-fields.eml',
    label: 'Missing regulatory identifiers',
    expectedOutcome: 'needs_information',
    note: 'A line item is missing two of the four fields the SOP gates on, so the forwarder is asked.',
  },
  {
    file: 'missing-coa.eml',
    label: 'Certificate of analysis missing',
    expectedOutcome: 'needs_information',
    note: 'An invoiced batch has no certificate. Trigger the reply below afterwards to watch the loop close.',
  },
  {
    file: 'missing-coa-reply.eml',
    label: 'The reply that closes the loop',
    expectedOutcome: 'ready',
    note: 'The missing certificate arrives on the same thread. Send this after the one above; it signals the same execution rather than starting a new one.',
  },
  {
    file: 'mawb-only.eml',
    label: 'Air shipment, no container',
    expectedOutcome: 'ready',
    note: 'Correlated by master air waybill instead of a container number.',
  },
  {
    file: 'registration-gap.eml',
    label: 'Registration Number absent',
    expectedOutcome: 'ready',
    note: 'Every blocking field is present and only the non-blocking one is missing, so it still receives and the gap is reported as a note.',
  },
  {
    file: 'duplicate-invoice.eml',
    label: 'Same invoice, different line items',
    expectedOutcome: 'rejected',
    note: 'A redelivery that contradicts what is already held. Send the complete pre-alert first.',
  },
  {
    file: 'no-business-key.eml',
    label: 'No usable business key',
    expectedOutcome: 'manual_review',
    note: 'Neither a container number nor an air waybill appears anywhere, so a human is asked rather than a guess made.',
  },
  {
    file: 'scanned-document.eml',
    label: 'Scan with no text layer',
    expectedOutcome: 'manual_review',
    note: 'OCR is disabled, so the document cannot be read and the run stops instead of inventing fields.',
  },
];

interface Projected extends Record<string, unknown> {
  key: string;
}

function headerOf(head: string, name: string): string {
  for (const line of head.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() === name.toLowerCase()) {
      return line.slice(separator + 1).trim();
    }
  }
  throw new Error(`fixture mail is missing the ${name} header`);
}

function project(pick: Pick): Projected {
  const raw = readFileSync(repoPath(`${EMAIL_DIR}/${pick.file}`), 'utf8');
  const split = raw.indexOf('\n\n');
  if (split === -1) throw new Error(`${pick.file} has no header/body separator`);
  const head = raw.slice(0, split);

  return {
    key: pick.file.replace(/\.eml$/, ''),
    label: pick.label,
    expectedOutcome: pick.expectedOutcome,
    note: pick.note,
    providerMessageId: headerOf(head, 'Message-ID'),
    threadId: headerOf(head, 'X-Meridian-Thread'),
    subject: headerOf(head, 'Subject'),
    receivedAt: headerOf(head, 'Date'),
    bodyText: raw.slice(split + 2).trim(),
  };
}

const HEADER = `/**
 * GENERATED FILE — regenerate with \`pnpm exec tsx scripts/regen-fixtures.ts\`.
 *
 * The committed fixture mail, as a constant the browser can read.
 *
 * It is a constant rather than a directory listing because the web app has no filesystem in
 * production and \`examples/\` is not part of its deployment bundle. The worker reads those files; the
 * browser only needs enough to name a message and hand it to intake, which is what this carries.
 *
 * \`expectedOutcome\` is documentation for whoever is clicking, not an assertion. The eval suite is
 * where outcomes are asserted; a label here that disagreed with a run would be a stale comment
 * rather than a failure, so it is derived from the same source as the mail itself.
 */

export interface DemoMessage {
  key: string;
  label: string;
  expectedOutcome: 'ready' | 'needs_information' | 'rejected' | 'manual_review' | 'completed';
  note: string;
  providerMessageId: string;
  threadId: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
}

export const DEMO_MESSAGES: readonly DemoMessage[] = `;

export async function main(_argv: readonly string[] = []): Promise<void> {
  const projected = PICKS.map(project);
  writeFileSync(repoPath(OUTPUT), `${HEADER}${JSON.stringify(projected, null, 2)};\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ path: OUTPUT, messages: projected.length }, null, 2)}\n`,
  );
}
