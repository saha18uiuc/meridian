import { mkdirSync, writeFileSync } from 'node:fs';
import type { AgentDecision, EvalCase } from '@meridian/core/schemas';
import { CONTAINERS, MAWB_AIR, SCALE_GOODS } from './documents.js';
import { repoPath } from '../lib/state.js';

/**
 * Author the sixteen eval cases and their expected decision documents.
 *
 * Every expectation below traces to a statement on the frozen board, and the trace is recorded in
 * the case file itself rather than in a document someone has to remember to update. An expectation
 * with no trace would be this project doing the exact thing it exists to prevent: encoding business
 * policy nobody agreed to, in a place nobody reviews.
 *
 * The cases are generated rather than hand-written because the expected documents repeat a lot of
 * structure, and a copy-paste slip in a fixture is a test that passes for the wrong reason.
 */

const CASE_DIR = 'examples/inbound-import-receiving/evals';
const EXPECTED_DIR = 'examples/inbound-import-receiving/fixtures/expected';
const EMAILS = 'examples/inbound-import-receiving/fixtures/emails';
const ATTACHMENTS = 'examples/inbound-import-receiving/fixtures/attachments';

type Failure = AgentDecision['findings'][number];

interface Draft {
  caseKey: string;
  description: string;
  specTrace: string;
  emails: string[];
  attachments: string[];
  expected: EvalCase['expected'];
  decision: AgentDecision | null;
}

function summary(input: {
  container?: string | null;
  mawb?: string | null;
  invoices?: string[];
  batches?: string[];
  goods?: number;
  validGoods?: number;
}): Record<string, unknown> {
  return {
    containerNumber: input.container ?? null,
    mawb: input.mawb ?? null,
    invoiceNumbers: input.invoices ?? [],
    batchNumbers: input.batches ?? [],
    goodsCount: input.goods ?? 0,
    validGoodsCount: input.validGoods ?? 0,
  };
}

/**
 * The SOP requires an error to name the Invoice Number, the Drug Description, and the Missing
 * Information Type, so the expectation is written the same way the agent writes it. Rebuilding the
 * sentence here rather than importing it from the agent is deliberate: an expectation that calls
 * the code it is checking cannot catch the code changing its mind.
 */
function missingFieldFailure(
  invoiceNumber: string,
  lineKey: string,
  description: string,
  field: string,
  label: string,
): Failure {
  return {
    scope: 'good',
    key: lineKey,
    field,
    message: `Invoice ${invoiceNumber}, ${description}: missing ${label}.`,
  };
}

function batchFailure(key: string, message: string): Failure {
  return { scope: 'batch', key, field: 'certificateOfAnalysis', message };
}

function missingList(failures: readonly Failure[]): string[] {
  return [...new Set(failures.map((f) => `${f.scope}:${f.key}:${f.field}`))].sort();
}

const EMPTY_SUMMARY = summary({});

function scaleBatches(): string[] {
  return Array.from({ length: SCALE_GOODS }, (_, i) => `SCL${String(i + 1).padStart(2, '0')}`);
}

function scaleStepKeys(): string[] {
  return Array.from(
    { length: SCALE_GOODS },
    (_, i) => `validate-good:INV-1040:LINE-${String(i + 1).padStart(2, '0')}`,
  );
}

export function drafts(): Draft[] {
  const case02Failures: Failure[] = [
    missingFieldFailure(
      'INV-1025',
      'LINE-1',
      'Metformin HCl Tablets 850mg',
      'andaNumber',
      'ANDA number',
    ),
    missingFieldFailure(
      'INV-1025',
      'LINE-1',
      'Metformin HCl Tablets 850mg',
      'ndcNumber',
      'NDC number',
    ),
  ];

  const case05Failures: Failure[] = [
    batchFailure('C31D', 'Invoice INV-1026, batch C31D: no Certificate of Analysis was attached.'),
  ];

  const case06Failures: Failure[] = [
    batchFailure('B77B', 'Invoice INV-1024, batch B77B: no Certificate of Analysis was attached.'),
    batchFailure(
      'B77C',
      'Batch B77C: a Certificate of Analysis was attached for a batch that appears on no invoice in this shipment.',
    ),
  ];

  return [
    {
      caseKey: 'case-01',
      description: 'A complete arrival notice with invoice, packing list, and both certificates.',
      specTrace:
        'Rule "Does each batch have exactly one certificate of analysis?" branch "exactly one certificate per batch" leads to Outcome "Ready to receive".',
      emails: ['happy-path.eml'],
      attachments: ['invoice-1024.pdf', 'packing-list-1024.pdf', 'coa-B77A.pdf', 'coa-B77B.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: CONTAINERS.happyPath,
        missingFields: [],
        externalActions: [],
        stepInstanceKeys: [
          `correlate:${CONTAINERS.happyPath}`,
          `extract:${CONTAINERS.happyPath}`,
          'validate-good:INV-1024:LINE-1',
          'validate-good:INV-1024:LINE-2',
          `decide:${CONTAINERS.happyPath}`,
        ],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024'],
            batches: ['B77A', 'B77B'],
            goods: 2,
            validGoods: 2,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-02',
      description: 'A good missing two of the four required regulatory identifiers.',
      specTrace:
        'Rule "Does every good carry the four required fields?" branch "required product fields missing" leads to Action "Ask the forwarder for the missing information".',
      emails: ['missing-fields.eml'],
      attachments: ['invoice-1025.pdf', 'coa-B90X.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingFields,
        missingFields: missingList(case02Failures),
        // `mail.reply`, not `mail.send`: the information request goes back onto the forwarder's own
        // thread, and the runtime types the action from the payload it is given. Both runtimes
        // derive it the same way, so this is what a live run records too.
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        stepInstanceKeys: [
          `extract:${CONTAINERS.missingFields}`,
          'validate-good:INV-1025:LINE-1',
          `respond:${CONTAINERS.missingFields}`,
        ],
        evidenceKeys: [`assessment:${CONTAINERS.missingFields}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingFields,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.missingFields,
            invoices: ['INV-1025'],
            batches: ['B90X'],
            goods: 1,
            validGoods: 0,
          }),
          missingInformation: missingList(case02Failures),
        },

        findings: case02Failures,
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-03',
      description: 'The same invoice number arrives twice with different line items.',
      specTrace:
        'Rule "Has this invoice already been received?" branch "invoice belongs to a different shipment" leads to Outcome "Rejected as inconsistent".',
      emails: ['happy-path.eml', 'conflicting-invoice.eml'],
      attachments: ['invoice-1024.pdf', 'invoice-1024-revised.pdf'],
      expected: {
        outcome: 'rejected',
        businessKey: CONTAINERS.happyPath,
        externalActions: [],
        stepInstanceKeys: [`decide:${CONTAINERS.happyPath}`],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'rejected',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024'],
            batches: ['B77A', 'B77B'],
            goods: 2,
            validGoods: 2,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-04',
      description: 'One batch appears on two different invoices in the same shipment.',
      specTrace:
        'Rule "Has this invoice already been received?" branch "invoice belongs to a different shipment" leads to Outcome "Rejected as inconsistent"; a batch is one physical lot.',
      emails: ['happy-path.eml', 'duplicate-batch.eml'],
      attachments: ['invoice-1024.pdf', 'invoice-1028.pdf'],
      expected: {
        outcome: 'rejected',
        businessKey: CONTAINERS.happyPath,
        externalActions: [],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'rejected',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024', 'INV-1028'],
            batches: ['B77A', 'B77B'],
            goods: 3,
            validGoods: 3,
          }),
          missingInformation: ['batch:B77A:batchNumber'],
        },
        // The duplicated batch is the only finding: `happy-path.eml` carries coa-B77A and coa-B77B,
        // so both batches on this shipment are certified. The failure is that INV-1028 re-uses a
        // batch INV-1024 already claimed, and one batch is one physical lot.

        findings: [
          {
            scope: 'batch',
            key: 'B77A',
            field: 'batchNumber',
            message: 'Batch B77A appears on more than one good in this shipment.',
          },
        ],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-05',
      description: 'An invoiced batch with no certificate of analysis.',
      specTrace:
        'Rule "Does each batch have exactly one certificate of analysis?" branch "certificate missing or ambiguous" leads to Action "Ask the forwarder for the missing information".',
      emails: ['missing-coa.eml'],
      attachments: ['invoice-1026.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingCoa,
        missingFields: missingList(case05Failures),
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        stepInstanceKeys: [`respond:${CONTAINERS.missingCoa}`],
        evidenceKeys: [`assessment:${CONTAINERS.missingCoa}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingCoa,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.missingCoa,
            invoices: ['INV-1026'],
            batches: ['C31D'],
            goods: 1,
            validGoods: 1,
          }),
          missingInformation: missingList(case05Failures),
        },

        findings: case05Failures,
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-06',
      description:
        'A certificate names a batch that appears on no invoice, and one batch has none.',
      specTrace:
        'Rule "Does each batch have exactly one certificate of analysis?" requires the match in both directions.',
      emails: ['coa-mismatch.eml'],
      attachments: ['invoice-1024.pdf', 'coa-B77A.pdf', 'coa-B77C.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.happyPath,
        missingFields: missingList(case06Failures),
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024'],
            batches: ['B77A', 'B77B'],
            goods: 2,
            validGoods: 2,
          }),
          missingInformation: missingList(case06Failures),
        },

        findings: case06Failures,
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-07',
      description: 'An air shipment correlated by master air waybill rather than container.',
      specTrace:
        'Input "Arrival notice email" declares correlationKeys containerNumber and mawb; either is sufficient.',
      emails: ['mawb-only.eml'],
      attachments: ['invoice-1027.pdf', 'coa-D14E.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: MAWB_AIR,
        externalActions: [],
        stepInstanceKeys: [`correlate:${MAWB_AIR}`, 'validate-good:INV-1027:LINE-1'],
        evidenceKeys: [`assessment:${MAWB_AIR}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: MAWB_AIR,
        reason: '',
        summary: {
          ...summary({
            mawb: MAWB_AIR,
            invoices: ['INV-1027'],
            batches: ['D14E'],
            goods: 1,
            validGoods: 1,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-08',
      description: 'A message with no valid container number or air waybill.',
      specTrace:
        'Rule "Is a shipment business key present?" branch "no usable business key" leads to Outcome "Manual review required".',
      emails: ['no-business-key.eml'],
      attachments: ['scanned-invoice.pdf'],
      expected: {
        outcome: 'manual_review',
        businessKey: null,
        externalActions: [],
      },
      decision: {
        outcome: 'manual_review',
        businessKey: null,
        reason: '',
        summary: { ...EMPTY_SUMMARY, missingInformation: [] },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-09',
      description: 'Two different valid container numbers in one message.',
      specTrace:
        'Rule "Is a shipment business key present?" branch "no usable business key" covers the conflict case explicitly.',
      emails: ['conflicting-keys.eml'],
      attachments: [],
      expected: {
        outcome: 'manual_review',
        businessKey: null,
        externalActions: [],
      },
      decision: {
        outcome: 'manual_review',
        businessKey: null,
        reason: '',
        summary: { ...EMPTY_SUMMARY, missingInformation: [] },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-10',
      description: 'A follow-up message that redelivers an invoice already held for the shipment.',
      specTrace:
        'Rule "Has this invoice already been received?" branch "invoice already received on this shipment" leads to Outcome "Already received".',
      emails: ['happy-path.eml', 'duplicate-invoice.eml'],
      attachments: ['invoice-1024.pdf'],
      expected: {
        outcome: 'completed',
        businessKey: CONTAINERS.happyPath,
        externalActions: [],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'completed',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024'],
            batches: ['B77A', 'B77B'],
            goods: 2,
            validGoods: 2,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-11',
      description: 'A transient extraction failure that succeeds on the next attempt.',
      specTrace:
        'Rule "Retry a transient extraction failure" bounds retries at three attempts before the exception path.',
      emails: ['happy-path.eml'],
      attachments: ['invoice-1024.pdf', 'packing-list-1024.pdf', 'coa-B77A.pdf', 'coa-B77B.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: CONTAINERS.happyPath,
        externalActions: [],
        evidenceKeys: [`assessment:${CONTAINERS.happyPath}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.happyPath,
            invoices: ['INV-1024'],
            batches: ['B77A', 'B77B'],
            goods: 2,
            validGoods: 2,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-12',
      description: 'A scanned document with no text layer while OCR is disabled.',
      specTrace:
        'Rule "Escalate an unexpected failure" routes a document the process cannot read to Outcome "Manual review required".',
      emails: ['scanned-document.eml'],
      attachments: ['scanned-invoice.pdf'],
      expected: {
        outcome: 'manual_review',
        businessKey: CONTAINERS.scanned,
        externalActions: [],
        stepInstanceKeys: [`escalate:${CONTAINERS.scanned}`],
        evidenceKeys: [`escalation:${CONTAINERS.scanned}`],
        humanDecisionRequired: true,
      },
      decision: {
        outcome: 'manual_review',
        businessKey: CONTAINERS.scanned,
        reason: '',
        summary: { ...summary({ container: CONTAINERS.scanned }), missingInformation: [] },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-13',
      description: 'A certificate arrives with no commercial invoice, so a specialist is asked.',
      specTrace:
        'Input "Commercial invoice" is required:true, and Action "Escalate to a receiving specialist" is the declared human handoff.',
      emails: ['late-followup.eml'],
      attachments: ['coa-B77C.pdf'],
      expected: {
        outcome: 'manual_review',
        businessKey: CONTAINERS.happyPath,
        externalActions: [],
        stepInstanceKeys: [`escalate:${CONTAINERS.happyPath}`],
        evidenceKeys: [`escalation:${CONTAINERS.happyPath}`],
        humanDecisionRequired: true,
      },
      decision: {
        outcome: 'manual_review',
        businessKey: CONTAINERS.happyPath,
        reason: '',
        summary: { ...summary({ container: CONTAINERS.happyPath }), missingInformation: [] },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-14',
      description: `A shipment with ${String(SCALE_GOODS)} goods validated in bounded parallel batches.`,
      specTrace:
        'Rule "Does every good carry the four required fields?" applies per good; step identity is step_instance_key, never sequence_no.',
      emails: ['scale-shipment.eml'],
      attachments: ['invoice-scale.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: CONTAINERS.scale,
        externalActions: [],
        stepInstanceKeys: scaleStepKeys(),
        evidenceKeys: [`assessment:${CONTAINERS.scale}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: CONTAINERS.scale,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.scale,
            invoices: ['INV-1040'],
            batches: scaleBatches(),
            goods: SCALE_GOODS,
            validGoods: SCALE_GOODS,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-15',
      description: 'The agent is replayed after dispatching an email; the send is not repeated.',
      specTrace:
        'Action "Ask the forwarder for the missing information" states exactly one request per shipment per round.',
      emails: ['missing-coa.eml'],
      attachments: ['invoice-1026.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingCoa,
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        evidenceKeys: [`assessment:${CONTAINERS.missingCoa}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: CONTAINERS.missingCoa,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.missingCoa,
            invoices: ['INV-1026'],
            batches: ['C31D'],
            goods: 1,
            validGoods: 1,
          }),
          missingInformation: missingList(case05Failures),
        },

        findings: case05Failures,
        emailResponse: null,
      },
    },

    {
      caseKey: 'case-16',
      description:
        'An invoice carrying all four required identifiers but no Registration Number still receives.',
      specTrace:
        'Input "Commercial invoice" marks registrationNumber not required; Rule "Does every good carry the four required fields?" names HTS, FDA product code, NDC, and ANDA only.',
      emails: ['registration-gap.eml'],
      attachments: ['invoice-1031.pdf', 'coa-E22F.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: CONTAINERS.registrationGap,
        missingFields: [],
        // The absent field is reported, and reporting it is all that happens: no request goes out,
        // because the SOP does not make receiving contingent on the Registration Number.
        externalActions: [],
        stepInstanceKeys: [
          `extract:${CONTAINERS.registrationGap}`,
          'validate-good:INV-1031:LINE-1',
          `decide:${CONTAINERS.registrationGap}`,
        ],
        evidenceKeys: [`assessment:${CONTAINERS.registrationGap}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: CONTAINERS.registrationGap,
        reason: '',
        summary: {
          ...summary({
            container: CONTAINERS.registrationGap,
            invoices: ['INV-1031'],
            batches: ['E22F'],
            goods: 1,
            validGoods: 1,
          }),
          missingInformation: [],
        },

        findings: [],
        emailResponse: null,
      },
    },
  ];
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  mkdirSync(repoPath(CASE_DIR), { recursive: true });
  mkdirSync(repoPath(EXPECTED_DIR), { recursive: true });

  const all = drafts();
  if (all.length !== 16) throw new Error(`expected 16 eval cases, built ${String(all.length)}`);

  for (const draft of all) {
    const evalCase: EvalCase = {
      caseKey: draft.caseKey,
      description: draft.description,
      specTrace: draft.specTrace,
      inputRefs: {
        emailPaths: draft.emails.map((name) => `${EMAILS}/${name}`),
        attachmentPaths: draft.attachments.map((name) => `${ATTACHMENTS}/${name}`),
        expectedPath: `${EXPECTED_DIR}/${draft.caseKey}.expected.json`,
      },
      expected: draft.expected,
    };
    writeFileSync(
      repoPath(`${CASE_DIR}/${draft.caseKey}.json`),
      `${JSON.stringify(evalCase, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      repoPath(`${EXPECTED_DIR}/${draft.caseKey}.expected.json`),
      `${JSON.stringify({ caseKey: draft.caseKey, decision: draft.decision }, null, 2)}\n`,
      'utf8',
    );
  }

  process.stdout.write(`${JSON.stringify({ cases: all.length }, null, 2)}\n`);
}
