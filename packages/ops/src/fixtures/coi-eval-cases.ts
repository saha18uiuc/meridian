import { mkdirSync, writeFileSync } from 'node:fs';
import type { AgentDecision, EvalCase } from '@meridian/core/schemas';
import { VENDORS } from './coi-documents.js';
import { repoPath } from '../lib/state.js';

/**
 * The vendor renewal suite: one case per branch the board declares.
 *
 * Deliberately narrow. The receiving suite carries the breadth — concurrency, replay, duplicate
 * suppression, fault injection, scale — and repeating that here would test the harness twice rather
 * than the second deployment once. What these cases establish is the thing the second deployment
 * exists to establish: the runtime carries a process it knows nothing about, from correlation
 * through extraction and rules to an outcome and an external action.
 */

const CASE_DIR = 'examples/vendor-coi-renewal/evals';
const EXPECTED_DIR = 'examples/vendor-coi-renewal/fixtures/expected';
const EMAILS = 'examples/vendor-coi-renewal/fixtures/emails';
const ATTACHMENTS = 'examples/vendor-coi-renewal/fixtures/attachments';

const RENEWAL_DATE = '2026-03-02';

type Finding = AgentDecision['findings'][number];

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
  vendorId: string;
  policyNumbers?: string[];
  coverageAmount?: number | null;
  expiryDate?: string | null;
  missing?: string[];
}): Record<string, unknown> {
  return {
    vendorId: input.vendorId,
    renewalDate: RENEWAL_DATE,
    policyNumbers: input.policyNumbers ?? [],
    coverageAmount: input.coverageAmount ?? null,
    expiryDate: input.expiryDate ?? null,
    missingInformation: input.missing ?? [],
  };
}

function missingList(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => `${f.scope}:${f.key}:${f.field}`))].sort();
}

export function drafts(): Draft[] {
  const underinsured: Finding[] = [
    {
      scope: 'policy',
      key: 'GL-88232',
      field: 'coverageAmount',
      message:
        'Policy GL-88232 carries USD 500000 of general liability cover, below the contracted minimum of USD 1000000.',
    },
  ];

  const incomplete: Finding[] = [
    {
      scope: 'certificate',
      key: 'GL-88233',
      field: 'coverageAmount',
      message: 'Certificate GL-88233 does not state a coverage amount.',
    },
    {
      scope: 'certificate',
      key: 'GL-88233',
      field: 'expiryDate',
      message: 'Certificate GL-88233 does not state a expiry date.',
    },
  ];

  const lapsed: Finding[] = [
    {
      scope: 'policy',
      key: 'GL-88234',
      field: 'expiryDate',
      message: `Policy GL-88234 expired on 2026-01-15, before the renewal date ${RENEWAL_DATE}.`,
    },
  ];

  return [
    {
      caseKey: 'coi-01',
      description: 'A complete certificate, adequately covered and in force, is accepted.',
      specTrace:
        'Rule "Is the policy still in force?" branch "policy in force" leads to Outcome "Certificate accepted".',
      emails: ['coi-compliant.eml'],
      attachments: ['coi-compliant.pdf'],
      expected: {
        outcome: 'ready',
        businessKey: VENDORS.compliant,
        missingFields: [],
        externalActions: [],
        stepInstanceKeys: [
          `correlate:${VENDORS.compliant}`,
          `extract:${VENDORS.compliant}`,
          `assess:${VENDORS.compliant}`,
        ],
        evidenceKeys: [`assessment:${VENDORS.compliant}`],
      },
      decision: {
        outcome: 'ready',
        businessKey: VENDORS.compliant,
        reason: '',
        summary: summary({
          vendorId: VENDORS.compliant,
          policyNumbers: ['GL-88231'],
          coverageAmount: 2_000_000,
          expiryDate: '2027-01-31',
        }),
        findings: [],
        emailResponse: null,
      },
    },

    {
      caseKey: 'coi-02',
      description: 'Coverage below the contracted minimum is rejected rather than queried.',
      specTrace:
        'Rule "Does coverage meet the contracted minimum?" branch "coverage below minimum" leads to Outcome "Certificate rejected".',
      emails: ['coi-underinsured.eml'],
      attachments: ['coi-underinsured.pdf'],
      expected: {
        outcome: 'rejected',
        businessKey: VENDORS.underinsured,
        missingFields: missingList(underinsured),
        // No mail goes out: the vendor has already told us how much cover they carry, and asking
        // again would be the process pretending a reply could change the answer.
        externalActions: [],
        evidenceKeys: [`assessment:${VENDORS.underinsured}`],
      },
      decision: {
        outcome: 'rejected',
        businessKey: VENDORS.underinsured,
        reason: '',
        summary: summary({
          vendorId: VENDORS.underinsured,
          policyNumbers: ['GL-88232'],
          coverageAmount: 500_000,
          expiryDate: '2027-01-31',
          missing: missingList(underinsured),
        }),
        findings: underinsured,
        emailResponse: null,
      },
    },

    {
      caseKey: 'coi-03',
      description: 'A certificate missing its limit and expiry is queried, not inferred.',
      specTrace:
        'Rule "Does the certificate carry every required field?" branch "certificate incomplete" leads to Action "Ask the vendor for a corrected certificate".',
      emails: ['coi-incomplete.eml'],
      attachments: ['coi-incomplete.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: VENDORS.incomplete,
        missingFields: missingList(incomplete),
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        stepInstanceKeys: [`respond:${VENDORS.incomplete}`],
        evidenceKeys: [`assessment:${VENDORS.incomplete}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: VENDORS.incomplete,
        reason: '',
        summary: summary({
          vendorId: VENDORS.incomplete,
          policyNumbers: ['GL-88233'],
          missing: missingList(incomplete),
        }),
        findings: incomplete,
        emailResponse: null,
      },
    },

    {
      caseKey: 'coi-04',
      description: 'A well-formed certificate that expired before the renewal date is queried.',
      specTrace:
        'Rule "Is the policy still in force?" branch "policy already lapsed" leads to Action "Ask the vendor for a corrected certificate".',
      emails: ['coi-lapsed.eml'],
      attachments: ['coi-lapsed.pdf'],
      expected: {
        outcome: 'needs_information',
        businessKey: VENDORS.lapsed,
        missingFields: missingList(lapsed),
        externalActions: [{ actionType: 'mail.reply', count: 1, finalStatus: 'succeeded' }],
        evidenceKeys: [`assessment:${VENDORS.lapsed}`],
      },
      decision: {
        outcome: 'needs_information',
        businessKey: VENDORS.lapsed,
        reason: '',
        summary: summary({
          vendorId: VENDORS.lapsed,
          policyNumbers: ['GL-88234'],
          coverageAmount: 2_000_000,
          expiryDate: '2026-01-15',
          missing: missingList(lapsed),
        }),
        findings: lapsed,
        emailResponse: null,
      },
    },

    {
      caseKey: 'coi-05',
      description: 'A scan with no text layer goes to a risk reviewer, not to a guess.',
      specTrace:
        'Rule "Escalate an unexpected failure" routes a document the process cannot read to Outcome "Risk review required".',
      emails: ['coi-scanned.eml'],
      attachments: ['coi-scanned.pdf'],
      expected: {
        outcome: 'manual_review',
        businessKey: VENDORS.unreadable,
        externalActions: [],
        stepInstanceKeys: [`escalate:${VENDORS.unreadable}`],
        evidenceKeys: [`escalation:${VENDORS.unreadable}`],
      },
      decision: {
        outcome: 'manual_review',
        businessKey: VENDORS.unreadable,
        reason: '',
        summary: {
          vendorId: VENDORS.unreadable,
          renewalDate: RENEWAL_DATE,
          policyNumbers: [],
          coverageAmount: null,
          expiryDate: null,
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
