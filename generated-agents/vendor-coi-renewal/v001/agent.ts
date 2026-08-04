import {
  assertCapability,
  chunk,
  defineAgent,
  type AgentContext,
  type AttachmentRef,
  type FileRef,
} from '@meridian/agent-kit/contracts';
import { AgentDecisionSchema, MessageRefSchema, type AgentDecision } from '@meridian/core/schemas';
import { z } from 'zod';
import {
  correctionBody,
  correctionSubject,
  EXTRACTION_SCHEMA_CERTIFICATE,
  handoffQuestion,
} from './prompts.js';
import {
  assessCertificate,
  outcomeFor,
  type Certificate,
  type CertificateFinding,
} from './rules.js';

/**
 * Vendor Insurance Certificate Renewal, version 001.
 *
 * Generated from the frozen specification recorded in `spec.snapshot.json`, through the same skill
 * and against the same contract as the receiving deployment. It imports only
 * `@meridian/agent-kit/contracts` and `@meridian/core/schemas`, so like every generated agent it
 * cannot reach a provider SDK, the database, the filesystem, or the wall clock.
 *
 * That this file and the receiving agent share no domain type is the point of the second example.
 * The platform underneath them knows about inputs, actions, rules, outcomes, capabilities, steps,
 * and evidence; it does not know what a shipment is, and it does not know what a policy is either.
 */

const InputSchema = z
  .object({
    businessKey: z.string().min(1),
    messages: z.array(MessageRefSchema),
    capabilities: z.array(z.string()),
  })
  .strict();

type RenewalInput = z.infer<typeof InputSchema>;

const SPEC_HASH = 'cbcac0172a5e337ab0103ebddc41754872d9635e94cc44b5e848474c30e2c09e';

/** Below this, a PDF has no usable text layer and needs OCR the process has not enabled. */
const MIN_READABLE_CHARS = 32;

/** Ordinals are display-only; identity is always `step_instance_key`. */
const STAGE = { correlate: 2, extract: 10, assess: 40, respond: 90 } as const;

function fileRefOf(attachment: AttachmentRef): FileRef {
  return {
    storagePath: attachment.storagePath ?? attachment.filename,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Coverage arrives as `1000000`, `"1,000,000"`, or `"USD 1,000,000"` depending on the carrier.
 * Anything that does not reduce to a finite number is treated as unstated rather than as zero,
 * because "the document did not say" and "the document said none" are different findings.
 */
function asAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9.]/g, '');
  if (digits === '') return null;
  const parsed = Number.parseFloat(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCertificate(fields: Record<string, unknown>, sourcePath: string): Certificate {
  return {
    policyNumber: asString(fields['policyNumber']),
    insurerName: asString(fields['insurerName']),
    coverageAmount: asAmount(fields['coverageAmount']),
    expiryDate: asString(fields['expiryDate']),
    additionalInsured: asString(fields['additionalInsured']),
    sourcePath,
  };
}

interface CollectedCertificates {
  certificates: Certificate[];
  unreadable: string[];
}

async function readCertificates(
  context: AgentContext,
  attachments: readonly AttachmentRef[],
): Promise<CollectedCertificates> {
  const documents = context.toolRegistry.documents;
  const certificates: Certificate[] = [];
  const unreadable: string[] = [];

  // Chunked rather than unbounded, and never `p-limit`: the workflow sandbox replays promise
  // resolution order, so bounded parallelism has to come from a deterministic partition.
  for (const group of chunk([...attachments], Math.max(1, context.config.maxConcurrency))) {
    const texts = await Promise.all(
      group.map(async (attachment) => documents.extractText(fileRefOf(attachment))),
    );
    for (const [index, attachment] of group.entries()) {
      const text = texts[index] ?? '';
      const ref = fileRefOf(attachment);
      if (text.trim().length < MIN_READABLE_CHARS) {
        unreadable.push(attachment.filename);
        continue;
      }
      if (!text.toUpperCase().includes('CERTIFICATE OF INSURANCE')) continue;
      const fields = await documents.extractFields(ref, EXTRACTION_SCHEMA_CERTIFICATE);
      certificates.push(toCertificate(fields, ref.storagePath));
    }
  }

  return {
    certificates: certificates.sort((a, b) =>
      (a.policyNumber ?? a.sourcePath).localeCompare(b.policyNumber ?? b.sourcePath),
    ),
    unreadable: unreadable.sort(),
  };
}

/**
 * The renewal date the run is judged against.
 *
 * Taken from the triggering message's receipt timestamp rather than from a clock, because a
 * workflow that read the clock would decide differently on replay and an eval case would stop being
 * reproducible the day after it was written.
 */
function renewalDateOf(input: RenewalInput): string {
  const dates = input.messages.map((message) => message.receivedAt).sort();
  return (dates[0] ?? '1970-01-01T00:00:00.000Z').slice(0, 10);
}

async function escalate(
  context: AgentContext,
  vendorId: string,
  renewalDate: string,
  reason: string,
  evidence: Record<string, unknown>,
): Promise<AgentDecision> {
  const step = await context.recorder.startStep({
    nodeId: null,
    stepKey: 'escalate',
    stepInstanceKey: `escalate:${vendorId}`,
    sequenceNo: STAGE.assess,
    inputSummary: { reason },
  });

  let reviewerNotes: string | null = null;
  if (context.capabilities.includes('human.handoff')) {
    const requestId = await context.toolRegistry.humanHandoff.requestDecision(
      handoffQuestion(vendorId, reason),
      evidence,
    );
    const answer = await context.toolRegistry.humanHandoff.waitForDecision(requestId);
    reviewerNotes = answer.notes ?? answer.decision;
  }

  await context.recorder.appendEvidence(
    step.stepExecutionId,
    { phase: 'escalation', reason, ...evidence },
    { eventKey: `escalation:${vendorId}` },
  );
  await context.recorder.completeStep(step.stepExecutionId, { reason, reviewerNotes });

  return {
    outcome: 'manual_review',
    businessKey: vendorId,
    reason,
    // Every key the deployment ever reports, even when the run stopped before it could fill them
    // in. A summary whose shape depends on the outcome is one every reader has to special-case.
    summary: {
      vendorId,
      renewalDate,
      policyNumbers: [],
      coverageAmount: null,
      expiryDate: null,
      missingInformation: [],
    },
    findings: [],
    emailResponse: null,
  };
}

/**
 * Ask the vendor for a corrected certificate.
 *
 * As in every deployment, the agent states the intent and the runtime owns the delivery guarantee:
 * `sendMessage` reserves the action against the execution, the step instance, and the canonical
 * payload before dispatching, so a replay after a crash finds the reservation rather than sending
 * twice. Crash recovery is not customer policy and is not re-implemented here.
 */
async function requestCorrection(
  context: AgentContext,
  vendorId: string,
  threadId: string | undefined,
  findings: readonly CertificateFinding[],
): Promise<AgentDecision['emailResponse']> {
  assertCapability(context, 'mail.send');

  const step = await context.recorder.startStep({
    nodeId: null,
    stepKey: 'respond',
    stepInstanceKey: `respond:${vendorId}`,
    sequenceNo: STAGE.respond,
    inputSummary: { findingCount: findings.length },
  });

  const recipient = context.config.operatorEmail;
  const email = {
    subject: correctionSubject(vendorId),
    body: correctionBody(vendorId, findings),
    recipient,
  };

  const sent = await context.toolRegistry.mailbox.sendMessage({
    to: recipient,
    subject: email.subject,
    body: email.body,
    ...(threadId === undefined ? {} : { threadId }),
  });

  await context.recorder.completeStep(step.stepExecutionId, {
    providerMessageId: sent.providerMessageId,
    recipient,
  });
  return email;
}

export const agent = defineAgent<RenewalInput, AgentDecision>({
  deploymentKey: 'vendor-coi-renewal',
  versionNo: 1,
  specHash: SPEC_HASH,
  inputSchema: InputSchema,
  decisionSchema: AgentDecisionSchema,

  async run(input, context) {
    const vendorId = input.businessKey;
    const renewalDate = renewalDateOf(input);
    assertCapability(context, 'mail.read');
    assertCapability(context, 'document.extract');

    // -------------------------------------------------------------------------- correlate
    const threadIds = [...new Set(input.messages.map((message) => message.threadId))].sort();
    const correlateStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'correlate',
      stepInstanceKey: `correlate:${vendorId}`,
      sequenceNo: STAGE.correlate,
      inputSummary: { threadIds, messageCount: input.messages.length },
    });

    const attachments: AttachmentRef[] = [];
    const seen = new Set<string>();
    for (const threadId of threadIds) {
      for (const attachment of await context.toolRegistry.mailbox.downloadAttachments(threadId)) {
        if (seen.has(attachment.attachmentId)) continue;
        seen.add(attachment.attachmentId);
        attachments.push(attachment);
      }
    }
    await context.recorder.completeStep(correlateStep.stepExecutionId, {
      attachmentCount: attachments.length,
      filenames: attachments.map((attachment) => attachment.filename).sort(),
    });

    // ---------------------------------------------------------------------------- extract
    const extractStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'extract',
      stepInstanceKey: `extract:${vendorId}`,
      sequenceNo: STAGE.extract,
      inputSummary: { attachmentCount: attachments.length },
    });
    const collected = await readCertificates(context, attachments);
    await context.recorder.completeStep(extractStep.stepExecutionId, {
      policyNumbers: collected.certificates.map((certificate) => certificate.policyNumber),
      unreadable: collected.unreadable,
    });

    if (collected.unreadable.length > 0) {
      return escalate(
        context,
        vendorId,
        renewalDate,
        `${String(collected.unreadable.length)} attachment(s) could not be read: ${collected.unreadable.join(', ')}`,
        { unreadable: collected.unreadable },
      );
    }

    // The Certificate of insurance Input card is `required: true`. Without one there is nothing to
    // assess, and treating a renewal request with no certificate as a lapse would be invention.
    if (collected.certificates.length === 0) {
      return escalate(context, vendorId, renewalDate, 'no certificate of insurance was attached', {
        filenames: attachments.map((attachment) => attachment.filename).sort(),
      });
    }

    // A vendor may send several certificates on one thread — a renewal plus an endorsement. All of
    // them are assessed and the strictest outcome wins, because accepting a renewal on the strength
    // of the most favourable document in the pile is exactly the mistake this check exists to stop.
    const assessments = collected.certificates.map((certificate) => ({
      certificate,
      assessment: assessCertificate(certificate, renewalDate),
    }));

    const findings = assessments.flatMap((entry) => entry.assessment.findings);
    const notes = assessments.flatMap((entry) => entry.assessment.notes);
    const outcomes = assessments.map((entry) => outcomeFor(entry.assessment));
    const outcome: AgentDecision['outcome'] = outcomes.includes('rejected')
      ? 'rejected'
      : outcomes.includes('needs_information')
        ? 'needs_information'
        : 'ready';

    let reason =
      outcome === 'ready'
        ? 'every certificate states the required fields, meets the contracted minimum, and is in force'
        : `${String(findings.length)} finding(s) on the certificates supplied`;
    if (notes.length > 0) {
      reason = `${reason} (${notes.map((note) => note.message).join(' ')})`;
    }

    const assessStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'assess',
      stepInstanceKey: `assess:${vendorId}`,
      sequenceNo: STAGE.assess,
      inputSummary: { certificateCount: collected.certificates.length, renewalDate },
    });
    await context.recorder.appendEvidence(
      assessStep.stepExecutionId,
      { phase: 'assessment', outcome, findings, notes, renewalDate },
      { eventKey: `assessment:${vendorId}` },
    );
    await context.recorder.completeStep(assessStep.stepExecutionId, { outcome, reason });

    // ----------------------------------------------------------------------------- respond
    let emailResponse: AgentDecision['emailResponse'] = null;
    if (outcome === 'needs_information') {
      emailResponse = await requestCorrection(context, vendorId, threadIds[0], findings);
    }

    const strongest = assessments[0]?.certificate ?? null;
    return {
      outcome,
      businessKey: vendorId,
      reason,
      summary: {
        vendorId,
        renewalDate,
        policyNumbers: collected.certificates
          .map((certificate) => certificate.policyNumber)
          .filter((value): value is string => value !== null)
          .sort(),
        coverageAmount: strongest?.coverageAmount ?? null,
        expiryDate: strongest?.expiryDate ?? null,
        missingInformation: [
          ...new Set(findings.map((finding) => `${finding.scope}:${finding.key}:${finding.field}`)),
        ].sort(),
      },
      findings,
      emailResponse,
    };
  },
});

export default agent;
