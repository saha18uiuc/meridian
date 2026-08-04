import { mkdirSync, writeFileSync } from 'node:fs';
import { isValidContainerNumber } from '../intake/extract-business-key.js';
import { repoPath } from '../lib/state.js';

/**
 * Regenerate the eval fixture corpus: the `.eml` messages, the attachment PDFs, and the extraction
 * index the mock document tool reads.
 *
 * The PDFs are real, minimal PDF 1.4 files carrying the same text the index records, so the live
 * `pdf-parse` path has something genuine to read and the mock path and the live path cannot drift
 * into describing different documents. They are generated rather than hand-written because a
 * hand-edited PDF whose byte offsets no longer match its xref is a debugging afternoon nobody
 * needs.
 *
 * Every container number here is check-digit valid, asserted at generation time. An invalid one
 * would silently turn a correlation case into a no-business-key case and the suite would still be
 * green while testing the wrong thing.
 */

const EMAIL_DIR = 'examples/inbound-import-receiving/fixtures/emails';
const ATTACHMENT_DIR = 'examples/inbound-import-receiving/fixtures/attachments';

// ------------------------------------------------------------------------------ PDF writer

function escapePdfText(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A single-page PDF whose content stream draws `text`, one line per row. */
export function renderPdf(text: string): Buffer {
  const lines = text.split('\n');
  const content = [
    'BT',
    '/F1 9 Tf',
    '11 TL',
    '36 756 Td',
    ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// -------------------------------------------------------------------------- document models

interface FixtureGood {
  lineKey: string;
  description: string;
  batchNumber: string | null;
  htsCode: string | null;
  fdaProductCode: string | null;
  andaNumber: string | null;
  registrationNumber: string | null;
  ndcNumber: string | null;
}

export interface FixtureEntry {
  text: string;
  fields: Record<string, unknown>;
}

const REGISTRATION = '3006521049';

function good(
  lineKey: string,
  description: string,
  batchNumber: string,
  htsCode: string,
  andaNumber: string | null,
  ndcNumber: string | null,
  registrationNumber: string | null = REGISTRATION,
): FixtureGood {
  return {
    lineKey,
    description,
    batchNumber,
    htsCode,
    fdaProductCode: '62L',
    andaNumber,
    registrationNumber,
    ndcNumber,
  };
}

function renderGoodLine(entry: FixtureGood): string {
  return [
    `Line ${entry.lineKey}: ${entry.description}`,
    `  Batch: ${entry.batchNumber ?? 'NOT PROVIDED'}`,
    `  HTS Code: ${entry.htsCode ?? 'NOT PROVIDED'}`,
    `  FDA Product Code: ${entry.fdaProductCode ?? 'NOT PROVIDED'}`,
    `  ANDA Number: ${entry.andaNumber ?? 'NOT PROVIDED'}`,
    `  Registration Number: ${entry.registrationNumber ?? 'NOT PROVIDED'}`,
    `  NDC Number: ${entry.ndcNumber ?? 'NOT PROVIDED'}`,
  ].join('\n');
}

function invoiceEntry(invoiceNumber: string, goods: FixtureGood[]): FixtureEntry {
  const text = [
    `COMMERCIAL INVOICE ${invoiceNumber}`,
    'Seller: Meridian Pharma Exports Ltd.',
    'Buyer: Importer Receiving Inc.',
    '',
    ...goods.map(renderGoodLine),
  ].join('\n');
  return { text, fields: { invoice: { invoiceNumber, goods } } };
}

function coaEntry(batchNumber: string): FixtureEntry {
  return {
    text: [
      'CERTIFICATE OF ANALYSIS',
      `Batch Number: ${batchNumber}`,
      'Manufacturer: Meridian Pharma Exports Ltd.',
      'Assay: 99.4% (specification 98.0-102.0%)',
      'Result: PASS',
    ].join('\n'),
    fields: { coa: { batchNumber } },
  };
}

function packingListEntry(
  invoiceNumber: string,
  containerNumber: string,
  cartons: { batchNumber: string; units: number }[],
): FixtureEntry {
  return {
    text: [
      `PACKING LIST for ${invoiceNumber}`,
      `Container: ${containerNumber}`,
      ...cartons.map(
        (carton, index) =>
          `Carton ${String(index + 1)}: Batch ${carton.batchNumber}, ${String(carton.units)} units`,
      ),
    ].join('\n'),
    fields: { packingList: { invoiceNumber, containerNumber, cartons } },
  };
}

export const CONTAINERS = {
  happyPath: 'MSKU1234565',
  missingFields: 'TGHU7654320',
  missingCoa: 'CMAU9988771',
  scanned: 'HLXU1234561',
  scale: 'OOLU1234567',
  registrationGap: 'MEDU2000002',
} as const;

export const MAWB_AIR = '020-12345675';

/** The scale case validates this many goods in one shipment. */
export const SCALE_GOODS = 24;

function scaleGoods(): FixtureGood[] {
  return Array.from({ length: SCALE_GOODS }, (_, index) => {
    const label = String(index + 1).padStart(2, '0');
    return good(
      `LINE-${label}`,
      `Generic Tablet Product ${label}`,
      `SCL${label}`,
      '3004.90.9260',
      `ANDA0900${label}`,
      `0093-51${label}-98`,
    );
  });
}

export function buildAttachmentIndex(): Record<string, FixtureEntry> {
  const index: Record<string, FixtureEntry> = {};

  const good1024a = good(
    'LINE-1',
    'Amoxicillin Capsules 500mg',
    'B77A',
    '3004.10.1000',
    'ANDA065123',
    '0093-4155-73',
  );
  const good1024b = good(
    'LINE-2',
    'Cephalexin Capsules 250mg',
    'B77B',
    '3004.20.0000',
    'ANDA064987',
    '0093-3145-73',
  );

  index['invoice-1024.pdf'] = invoiceEntry('INV-1024', [good1024a, good1024b]);

  // Same invoice number, materially different goods. This is a conflict, not a redelivery, and the
  // agent must refuse to merge the two rather than pick one.
  index['invoice-1024-revised.pdf'] = invoiceEntry('INV-1024', [
    good(
      'LINE-1',
      'Amoxicillin Capsules 250mg',
      'B81A',
      '3004.10.1000',
      'ANDA065123',
      '0093-4155-74',
    ),
  ]);

  index['invoice-1025.pdf'] = invoiceEntry('INV-1025', [
    good('LINE-1', 'Metformin HCl Tablets 850mg', 'B90X', '3004.90.9260', null, null),
  ]);

  index['invoice-1026.pdf'] = invoiceEntry('INV-1026', [
    good(
      'LINE-1',
      'Losartan Potassium Tablets 50mg',
      'C31D',
      '3004.90.9260',
      'ANDA078112',
      '0378-5375-01',
    ),
  ]);

  index['invoice-1027.pdf'] = invoiceEntry('INV-1027', [
    good(
      'LINE-1',
      'Atorvastatin Tablets 20mg',
      'D14E',
      '3004.90.9260',
      'ANDA090123',
      '0093-5155-98',
    ),
  ]);

  // A second invoice that reuses batch B77A. One physical lot cannot be on two invoices at once.
  index['invoice-1028.pdf'] = invoiceEntry('INV-1028', [
    good(
      'LINE-1',
      'Amoxicillin Capsules 500mg',
      'B77A',
      '3004.10.1000',
      'ANDA065123',
      '0093-4155-73',
    ),
  ]);

  // Every field the SOP gates on is present; only the Registration Number the PRD adds is absent.
  // The shipment must still reach `ready`, which is the whole point of the two-list policy.
  index['invoice-1031.pdf'] = invoiceEntry('INV-1031', [
    good(
      'LINE-1',
      'Lisinopril Tablets 10mg',
      'E22F',
      '3004.90.9260',
      'ANDA076543',
      '0093-1029-56',
      null,
    ),
  ]);

  index['invoice-scale.pdf'] = invoiceEntry('INV-1040', scaleGoods());

  index['packing-list-1024.pdf'] = packingListEntry('INV-1024', CONTAINERS.happyPath, [
    { batchNumber: 'B77A', units: 240 },
    { batchNumber: 'B77B', units: 240 },
  ]);

  for (const batch of ['B77A', 'B77B', 'B77C', 'B90X', 'D14E', 'E22F']) {
    index[`coa-${batch}.pdf`] = coaEntry(batch);
  }
  for (let i = 1; i <= SCALE_GOODS; i += 1) {
    const label = String(i).padStart(2, '0');
    index[`coa-SCL${label}.pdf`] = coaEntry(`SCL${label}`);
  }

  // A scan with no text layer. The mock returns the same near-empty text the live extractor would
  // produce with OCR disabled, so both paths reach the same "unreadable" conclusion.
  index['scanned-invoice.pdf'] = {
    text: '[scan]',
    fields: { invoice: { invoiceNumber: 'INV-1030', goods: [] } },
  };

  return index;
}

// ------------------------------------------------------------------------------ email fixtures

export interface FixtureEmail {
  file: string;
  messageId: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  attachments: string[];
  body: string;
}

function scaleAttachments(): string[] {
  return [
    'invoice-scale.pdf',
    ...Array.from(
      { length: SCALE_GOODS },
      (_, i) => `coa-SCL${String(i + 1).padStart(2, '0')}.pdf`,
    ),
  ];
}

export function buildEmails(): FixtureEmail[] {
  return [
    {
      file: 'happy-path.eml',
      messageId: '<happy-path@forwarder.example>',
      threadId: 'thread-happy-path',
      date: '2026-02-03T09:12:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.happyPath} - PO 88213`,
      attachments: ['invoice-1024.pdf', 'packing-list-1024.pdf', 'coa-B77A.pdf', 'coa-B77B.pdf'],
      body: [
        'Good morning,',
        '',
        'Please find attached the commercial invoice, packing list and certificates of',
        `analysis for container ${CONTAINERS.happyPath}, arriving at the Port of Newark on`,
        '2026-02-07.',
        '',
        'Invoice INV-1024 covers two line items, batches B77A and B77B.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'missing-fields.eml',
      messageId: '<missing-fields@forwarder.example>',
      threadId: 'thread-missing-fields',
      date: '2026-02-04T08:05:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents for container ${CONTAINERS.missingFields}`,
      attachments: ['invoice-1025.pdf', 'coa-B90X.pdf'],
      body: [
        'Hello,',
        '',
        `Attaching the commercial invoice for container ${CONTAINERS.missingFields} together with`,
        'the certificate of analysis for batch B90X. The packing list will follow separately.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'conflicting-invoice.eml',
      messageId: '<conflicting-invoice@forwarder.example>',
      threadId: 'thread-happy-path',
      date: '2026-02-03T15:20:00.000Z',
      from: 'ops@forwarder.example',
      subject: `RE: Pre-Alert Documents - container ${CONTAINERS.happyPath} - PO 88213`,
      attachments: ['invoice-1024-revised.pdf'],
      body: [
        'Hello,',
        '',
        `Please use the attached invoice for container ${CONTAINERS.happyPath} instead. It carries`,
        'the same invoice number INV-1024 but a different line item and batch.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'duplicate-batch.eml',
      messageId: '<duplicate-batch@forwarder.example>',
      threadId: 'thread-happy-path',
      date: '2026-02-03T13:05:00.000Z',
      from: 'ops@forwarder.example',
      subject: `RE: Pre-Alert Documents - container ${CONTAINERS.happyPath} - additional invoice`,
      attachments: ['invoice-1028.pdf'],
      body: [
        'Hello,',
        '',
        `A second invoice for container ${CONTAINERS.happyPath} is attached. It covers batch B77A,`,
        'which also appears on invoice INV-1024.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'missing-coa.eml',
      messageId: '<missing-coa@forwarder.example>',
      threadId: 'thread-missing-coa',
      date: '2026-02-05T14:22:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.missingCoa} - invoice attached`,
      attachments: ['invoice-1026.pdf'],
      body: [
        'Hello,',
        '',
        `Invoice for container ${CONTAINERS.missingCoa} attached. Batch C31D is on the invoice; the`,
        'certificate of analysis is still with the manufacturer.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'coa-mismatch.eml',
      messageId: '<coa-mismatch@forwarder.example>',
      threadId: 'thread-coa-mismatch',
      date: '2026-02-05T09:40:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.happyPath} - certificates`,
      attachments: ['invoice-1024.pdf', 'coa-B77A.pdf', 'coa-B77C.pdf'],
      body: [
        'Hello,',
        '',
        `Certificates for container ${CONTAINERS.happyPath}. Batches B77A and B77C are covered.`,
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'mawb-only.eml',
      messageId: '<mawb-only@forwarder.example>',
      threadId: 'thread-mawb-only',
      date: '2026-02-06T06:30:00.000Z',
      from: 'airfreight@forwarder.example',
      subject: `APL USA // PRE-ALERT DOCUMENTATION - MAWB ${MAWB_AIR}`,
      attachments: ['invoice-1027.pdf', 'coa-D14E.pdf'],
      body: [
        `Pre-alert for air waybill ${MAWB_AIR}, three cartons, arriving JFK on`,
        '2026-02-08. No container is involved for this shipment.',
        '',
        'Regards,',
        'Global Forwarding Air Desk',
      ].join('\n'),
    },
    {
      file: 'no-business-key.eml',
      messageId: '<no-business-key@forwarder.example>',
      threadId: 'thread-no-business-key',
      date: '2026-02-06T10:15:00.000Z',
      from: 'ops@forwarder.example',
      subject: "Pre-Alert Documents for next week's arrival",
      attachments: ['scanned-invoice.pdf'],
      body: [
        'Hi,',
        '',
        'Attaching paperwork for the shipment we discussed on the call. Reference number',
        'to follow once the carrier confirms.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'conflicting-keys.eml',
      messageId: '<conflicting-keys@forwarder.example>',
      threadId: 'thread-conflicting-keys',
      date: '2026-02-06T12:45:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - combined update - ${CONTAINERS.happyPath} and ${CONTAINERS.missingFields}`,
      attachments: [],
      body: [
        'Hello,',
        '',
        `Consolidated update covering container ${CONTAINERS.happyPath} and container`,
        `${CONTAINERS.missingFields}. Both are on the same vessel; documents for each are attached`,
        'to the respective earlier threads.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'duplicate-invoice.eml',
      messageId: '<duplicate-invoice@forwarder.example>',
      threadId: 'thread-happy-path',
      date: '2026-02-03T11:40:00.000Z',
      from: 'ops@forwarder.example',
      subject: `RE: Pre-Alert Documents - container ${CONTAINERS.happyPath} - PO 88213`,
      attachments: ['invoice-1024.pdf'],
      body: [
        `Resending the invoice for container ${CONTAINERS.happyPath} in case the first message was`,
        'caught by your filter. Same document, no changes.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'late-followup.eml',
      messageId: '<late-followup@forwarder.example>',
      threadId: 'thread-late-followup',
      date: '2026-02-10T16:02:00.000Z',
      from: 'ops@forwarder.example',
      subject: `RE: Pre-Alert Documents - container ${CONTAINERS.happyPath} - certificate`,
      attachments: ['coa-B77C.pdf'],
      body: [
        `Following up on container ${CONTAINERS.happyPath}. The revised certificate of analysis for`,
        'batch B77C is attached; no invoice is included with this message.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'scanned-document.eml',
      messageId: '<scanned-document@forwarder.example>',
      threadId: 'thread-scanned-document',
      date: '2026-02-07T07:55:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.scanned} - scanned paperwork`,
      attachments: ['scanned-invoice.pdf'],
      body: [
        'Hello,',
        '',
        `Scanned paperwork for container ${CONTAINERS.scanned}. Our scanner produced an image-only`,
        'file; let us know if you need a text copy.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'registration-gap.eml',
      messageId: '<registration-gap@forwarder.example>',
      threadId: 'thread-registration-gap',
      date: '2026-02-09T08:20:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.registrationGap}`,
      attachments: ['invoice-1031.pdf', 'coa-E22F.pdf'],
      body: [
        'Hello,',
        '',
        `Invoice INV-1031 and the certificate of analysis for batch E22F, container`,
        `${CONTAINERS.registrationGap}. The manufacturer has not returned the establishment`,
        'registration number yet; everything else is on the invoice.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
    {
      file: 'scale-shipment.eml',
      messageId: '<scale-shipment@forwarder.example>',
      threadId: 'thread-scale-shipment',
      date: '2026-02-08T05:15:00.000Z',
      from: 'ops@forwarder.example',
      subject: `Pre-Alert Documents - container ${CONTAINERS.scale} - consolidated shipment`,
      attachments: scaleAttachments(),
      body: [
        'Hello,',
        '',
        `Consolidated invoice INV-1040 for container ${CONTAINERS.scale} covering ${String(SCALE_GOODS)}`,
        'line items, each with its certificate of analysis attached.',
        '',
        'Regards,',
        'Global Forwarding Operations',
      ].join('\n'),
    },
  ];
}

export function renderEmail(email: FixtureEmail): string {
  return [
    `Message-ID: ${email.messageId}`,
    `X-Meridian-Thread: ${email.threadId}`,
    `Date: ${email.date}`,
    `From: ${email.from}`,
    'To: receiving@importer.example',
    `Subject: ${email.subject}`,
    `X-Meridian-Attachments: ${email.attachments.join(', ')}`,
    '',
    email.body,
    '',
  ].join('\n');
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  for (const container of Object.values(CONTAINERS)) {
    if (!isValidContainerNumber(container)) {
      throw new Error(`fixture container number ${container} fails its ISO 6346 check digit`);
    }
  }

  mkdirSync(repoPath(EMAIL_DIR), { recursive: true });
  mkdirSync(repoPath(ATTACHMENT_DIR), { recursive: true });

  const index = buildAttachmentIndex();
  for (const [filename, entry] of Object.entries(index)) {
    writeFileSync(repoPath(`${ATTACHMENT_DIR}/${filename}`), renderPdf(entry.text));
  }

  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    repoPath(`${ATTACHMENT_DIR}/index.json`),
    `${JSON.stringify(sorted, null, 2)}\n`,
    'utf8',
  );

  const emails = buildEmails();
  for (const email of emails) {
    writeFileSync(repoPath(`${EMAIL_DIR}/${email.file}`), renderEmail(email), 'utf8');
  }

  process.stdout.write(
    `${JSON.stringify({ attachments: Object.keys(index).length, emails: emails.length }, null, 2)}\n`,
  );
}
