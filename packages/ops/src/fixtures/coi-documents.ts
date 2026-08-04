import { mkdirSync, writeFileSync } from 'node:fs';
import { repoPath } from '../lib/state.js';
import { renderEmail, renderPdf, type FixtureEmail, type FixtureEntry } from './documents.js';

/**
 * The mail and attachments the vendor renewal eval suite reads.
 *
 * Small on purpose. Its job is to make the second deployment actually execute — every branch its
 * board declares, once — so the claim that the runtime is domain-agnostic rests on runs rather than
 * on the fact that the code compiled. The first deployment's sixteen cases are where breadth lives.
 */

const EMAIL_DIR = 'examples/vendor-coi-renewal/fixtures/emails';
const ATTACHMENT_DIR = 'examples/vendor-coi-renewal/fixtures/attachments';

export const VENDORS = {
  compliant: 'VEND-40118',
  underinsured: 'VEND-40119',
  incomplete: 'VEND-40120',
  lapsed: 'VEND-40121',
  unreadable: 'VEND-40122',
} as const;

/** Every request is dated the same day, so `renewalDateOf` is stable across runs. */
const RENEWAL_DATE = '2026-03-02';

interface FixtureCertificate {
  policyNumber: string | null;
  insurerName: string | null;
  coverageAmount: number | null;
  expiryDate: string | null;
  additionalInsured: string | null;
}

function certificateEntry(certificate: FixtureCertificate): FixtureEntry {
  const line = (label: string, value: string | number | null): string =>
    `${label}: ${value === null ? 'NOT STATED' : String(value)}`;
  return {
    text: [
      'CERTIFICATE OF INSURANCE',
      line('Policy Number', certificate.policyNumber),
      line('Insurer', certificate.insurerName),
      line('General Liability Limit (USD)', certificate.coverageAmount),
      line('Expiry Date', certificate.expiryDate),
      line('Additional Insured', certificate.additionalInsured),
    ].join('\n'),
    fields: { certificateOfInsurance: certificate },
  };
}

export function buildCoiAttachmentIndex(): Record<string, FixtureEntry> {
  const index: Record<string, FixtureEntry> = {};

  index['coi-compliant.pdf'] = certificateEntry({
    policyNumber: 'GL-88231',
    insurerName: 'Northbridge Casualty',
    coverageAmount: 2_000_000,
    expiryDate: '2027-01-31',
    additionalInsured: 'Importer Receiving Inc.',
  });

  // Under the contracted minimum. Nothing a reply can fix, so the board rejects rather than asks.
  index['coi-underinsured.pdf'] = certificateEntry({
    policyNumber: 'GL-88232',
    insurerName: 'Harborline Mutual',
    coverageAmount: 500_000,
    expiryDate: '2027-01-31',
    additionalInsured: 'Importer Receiving Inc.',
  });

  // No expiry and no limit. Incomplete, which is not the same as expired or uninsured, and the
  // agent must not infer either.
  index['coi-incomplete.pdf'] = certificateEntry({
    policyNumber: 'GL-88233',
    insurerName: 'Cascade Indemnity',
    coverageAmount: null,
    expiryDate: null,
    additionalInsured: null,
  });

  // Well-formed, adequately covered, and already out of date on the renewal date.
  index['coi-lapsed.pdf'] = certificateEntry({
    policyNumber: 'GL-88234',
    insurerName: 'Northbridge Casualty',
    coverageAmount: 2_000_000,
    expiryDate: '2026-01-15',
    additionalInsured: 'Importer Receiving Inc.',
  });

  // A scan with no text layer, as in the receiving corpus: the mock returns what the live extractor
  // would return with OCR disabled, so both paths reach the same "unreadable" conclusion.
  index['coi-scanned.pdf'] = { text: '[scan]', fields: {} };

  return index;
}

function email(file: string, vendorId: string, attachments: string[], note: string): FixtureEmail {
  return {
    file,
    messageId: `<${file.replace('.eml', '')}@vendor.example>`,
    threadId: `thread-${file.replace('.eml', '')}`,
    date: `${RENEWAL_DATE}T09:00:00.000Z`,
    from: 'insurance@vendor.example',
    subject: `Certificate of Insurance renewal — ${vendorId}`,
    attachments,
    body: [
      'Hello,',
      '',
      `Attached is the certificate of insurance for vendor account ${vendorId}.`,
      note,
      '',
      'Regards,',
      'Vendor Compliance',
    ].join('\n'),
  };
}

export function buildCoiEmails(): FixtureEmail[] {
  return [
    email(
      'coi-compliant.eml',
      VENDORS.compliant,
      ['coi-compliant.pdf'],
      'Cover runs to the end of January next year.',
    ),
    email(
      'coi-underinsured.eml',
      VENDORS.underinsured,
      ['coi-underinsured.pdf'],
      'This is the level of cover we carry.',
    ),
    email(
      'coi-incomplete.eml',
      VENDORS.incomplete,
      ['coi-incomplete.pdf'],
      'The broker is still confirming some of the details.',
    ),
    email(
      'coi-lapsed.eml',
      VENDORS.lapsed,
      ['coi-lapsed.pdf'],
      'Please find our certificate on file.',
    ),
    email(
      'coi-scanned.eml',
      VENDORS.unreadable,
      ['coi-scanned.pdf'],
      'Our scanner produced an image-only file.',
    ),
  ];
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  mkdirSync(repoPath(EMAIL_DIR), { recursive: true });
  mkdirSync(repoPath(ATTACHMENT_DIR), { recursive: true });

  const index = buildCoiAttachmentIndex();
  for (const [filename, entry] of Object.entries(index)) {
    writeFileSync(repoPath(`${ATTACHMENT_DIR}/${filename}`), renderPdf(entry.text));
  }
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    repoPath(`${ATTACHMENT_DIR}/index.json`),
    `${JSON.stringify(sorted, null, 2)}\n`,
    'utf8',
  );

  const emails = buildCoiEmails();
  for (const entry of emails) {
    writeFileSync(repoPath(`${EMAIL_DIR}/${entry.file}`), renderEmail(entry), 'utf8');
  }

  process.stdout.write(
    `${JSON.stringify({ attachments: Object.keys(index).length, emails: emails.length }, null, 2)}\n`,
  );
}
