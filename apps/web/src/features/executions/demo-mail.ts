/**
 * GENERATED FILE — regenerate with `pnpm exec tsx scripts/regen-fixtures.ts`.
 *
 * The committed fixture mail, as a constant the browser can read.
 *
 * It is a constant rather than a directory listing because the web app has no filesystem in
 * production and `examples/` is not part of its deployment bundle. The worker reads those files; the
 * browser only needs enough to name a message and hand it to intake, which is what this carries.
 *
 * `expectedOutcome` is documentation for whoever is clicking, not an assertion. The eval suite is
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

export const DEMO_MESSAGES: readonly DemoMessage[] = [
  {
    key: 'happy-path',
    label: 'Complete pre-alert',
    expectedOutcome: 'ready',
    note: 'Invoice and both certificates attached. Every required field is present, so the shipment receives.',
    providerMessageId: '<happy-path@forwarder.example>',
    threadId: 'thread-happy-path',
    subject: 'Pre-Alert Documents - container MSKU1234565 - PO 88213',
    receivedAt: '2026-02-03T09:12:00.000Z',
    bodyText:
      'Good morning,\n\nPlease find attached the commercial invoice, packing list and certificates of\nanalysis for container MSKU1234565, arriving at the Port of Newark on\n2026-02-07.\n\nInvoice INV-1024 covers two line items, batches B77A and B77B.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'missing-fields',
    label: 'Missing regulatory identifiers',
    expectedOutcome: 'needs_information',
    note: 'A line item is missing two of the four fields the SOP gates on, so the forwarder is asked.',
    providerMessageId: '<missing-fields@forwarder.example>',
    threadId: 'thread-missing-fields',
    subject: 'Pre-Alert Documents for container TGHU7654320',
    receivedAt: '2026-02-04T08:05:00.000Z',
    bodyText:
      'Hello,\n\nAttaching the commercial invoice for container TGHU7654320 together with\nthe certificate of analysis for batch B90X. The packing list will follow separately.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'missing-coa',
    label: 'Certificate of analysis missing',
    expectedOutcome: 'needs_information',
    note: 'An invoiced batch has no certificate. Trigger the reply below afterwards to watch the loop close.',
    providerMessageId: '<missing-coa@forwarder.example>',
    threadId: 'thread-missing-coa',
    subject: 'Pre-Alert Documents - container CMAU9988771 - invoice attached',
    receivedAt: '2026-02-05T14:22:00.000Z',
    bodyText:
      'Hello,\n\nInvoice for container CMAU9988771 attached. Batch C31D is on the invoice; the\ncertificate of analysis is still with the manufacturer.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'missing-coa-reply',
    label: 'The reply that closes the loop',
    expectedOutcome: 'ready',
    note: 'The missing certificate arrives on the same thread. Send this after the one above; it signals the same execution rather than starting a new one.',
    providerMessageId: '<missing-coa-reply@forwarder.example>',
    threadId: 'thread-missing-coa',
    subject: 'RE: Pre-Alert Documents - container CMAU9988771 - invoice attached',
    receivedAt: '2026-02-06T11:05:00.000Z',
    bodyText:
      'Hello,\n\nThe manufacturer has released the certificate of analysis for batch C31D. It is attached.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'mawb-only',
    label: 'Air shipment, no container',
    expectedOutcome: 'ready',
    note: 'Correlated by master air waybill instead of a container number.',
    providerMessageId: '<mawb-only@forwarder.example>',
    threadId: 'thread-mawb-only',
    subject: 'APL USA // PRE-ALERT DOCUMENTATION - MAWB 020-12345675',
    receivedAt: '2026-02-06T06:30:00.000Z',
    bodyText:
      'Pre-alert for air waybill 020-12345675, three cartons, arriving JFK on\n2026-02-08. No container is involved for this shipment.\n\nRegards,\nGlobal Forwarding Air Desk',
  },
  {
    key: 'registration-gap',
    label: 'Registration Number absent',
    expectedOutcome: 'ready',
    note: 'Every blocking field is present and only the non-blocking one is missing, so it still receives and the gap is reported as a note.',
    providerMessageId: '<registration-gap@forwarder.example>',
    threadId: 'thread-registration-gap',
    subject: 'Pre-Alert Documents - container MEDU2000002',
    receivedAt: '2026-02-09T08:20:00.000Z',
    bodyText:
      'Hello,\n\nInvoice INV-1031 and the certificate of analysis for batch E22F, container\nMEDU2000002. The manufacturer has not returned the establishment\nregistration number yet; everything else is on the invoice.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'duplicate-invoice',
    label: 'Same invoice, different line items',
    expectedOutcome: 'rejected',
    note: 'A redelivery that contradicts what is already held. Send the complete pre-alert first.',
    providerMessageId: '<duplicate-invoice@forwarder.example>',
    threadId: 'thread-happy-path',
    subject: 'RE: Pre-Alert Documents - container MSKU1234565 - PO 88213',
    receivedAt: '2026-02-03T11:40:00.000Z',
    bodyText:
      'Resending the invoice for container MSKU1234565 in case the first message was\ncaught by your filter. Same document, no changes.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'no-business-key',
    label: 'No usable business key',
    expectedOutcome: 'manual_review',
    note: 'Neither a container number nor an air waybill appears anywhere, so a human is asked rather than a guess made.',
    providerMessageId: '<no-business-key@forwarder.example>',
    threadId: 'thread-no-business-key',
    subject: "Pre-Alert Documents for next week's arrival",
    receivedAt: '2026-02-06T10:15:00.000Z',
    bodyText:
      'Hi,\n\nAttaching paperwork for the shipment we discussed on the call. Reference number\nto follow once the carrier confirms.\n\nRegards,\nGlobal Forwarding Operations',
  },
  {
    key: 'scanned-document',
    label: 'Scan with no text layer',
    expectedOutcome: 'manual_review',
    note: 'OCR is disabled, so the document cannot be read and the run stops instead of inventing fields.',
    providerMessageId: '<scanned-document@forwarder.example>',
    threadId: 'thread-scanned-document',
    subject: 'Pre-Alert Documents - container HLXU1234561 - scanned paperwork',
    receivedAt: '2026-02-07T07:55:00.000Z',
    bodyText:
      'Hello,\n\nScanned paperwork for container HLXU1234561. Our scanner produced an image-only\nfile; let us know if you need a text copy.\n\nRegards,\nGlobal Forwarding Operations',
  },
];
