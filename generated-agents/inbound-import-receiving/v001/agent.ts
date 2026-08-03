import {
  assertCapability,
  chunk,
  defineAgent,
  type AgentContext,
  type AttachmentRef,
  type FileRef,
} from '@meridian/agent-kit/contracts';
import {
  AgentDecisionSchema,
  MessageRefSchema,
  type AgentDecision,
  type Coa,
  type Good,
  type Invoice,
} from '@meridian/core/schemas';
import { z } from 'zod';
import {
  EXTRACTION_SCHEMA_COA,
  EXTRACTION_SCHEMA_INVOICE,
  handoffQuestion,
  missingInformationBody,
  missingInformationSubject,
} from './prompts.js';
import {
  assessShipment,
  missingInformationList,
  type ShipmentAssessment,
  type ValidationFailure,
} from './rules.js';

/**
 * Inbound Import Receiving, version 001.
 *
 * Generated from the frozen specification recorded in `spec.snapshot.json`. This file orchestrates;
 * `rules.ts` decides and `prompts.ts` words. It imports only `@meridian/agent-kit/contracts` and
 * `@meridian/core/schemas`, so nothing here can reach a provider SDK, the database, the filesystem,
 * or the wall clock — which is what lets the identical code run inside the Temporal workflow
 * sandbox and inside the eval harness.
 *
 * Where the specification is silent, this agent stops and says so. It never fills a gap with a
 * plausible guess: an unreadable document and a shipment with no commercial invoice both end in
 * `manual_review` with the reason recorded, because the frozen spec defines neither.
 */

const InputSchema = z
  .object({
    businessKey: z.string().min(1),
    messages: z.array(MessageRefSchema),
    capabilities: z.array(z.string()),
  })
  .strict();

type ReceivingInput = z.infer<typeof InputSchema>;

const SPEC_HASH = 'fe51ae2b2d493bf18ec01b17f96152218b182f7a5fcc1c95274835f30d6eb44b';

/** Below this, a PDF has no usable text layer and needs OCR the process has not enabled. */
const MIN_READABLE_CHARS = 32;

type DocumentKind = 'invoice' | 'packingList' | 'coa' | 'unreadable';

interface ClassifiedDocument {
  kind: DocumentKind;
  attachment: AttachmentRef;
  text: string;
}

function classify(text: string): DocumentKind {
  const upper = text.toUpperCase();
  if (upper.includes('COMMERCIAL INVOICE')) return 'invoice';
  if (upper.includes('PACKING LIST')) return 'packingList';
  if (upper.includes('CERTIFICATE OF ANALYSIS')) return 'coa';
  return 'unreadable';
}

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

function toGood(raw: unknown, fallbackIndex: number): Good {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    lineKey: asString(record['lineKey']) ?? `LINE-${String(fallbackIndex + 1)}`,
    description: asString(record['description']) ?? '',
    batchNumber: asString(record['batchNumber']),
    htsCode: asString(record['htsCode']),
    fdaProductCode: asString(record['fdaProductCode']),
    andaNumber: asString(record['andaNumber']),
    registrationNumber: asString(record['registrationNumber']),
    ndcNumber: asString(record['ndcNumber']),
  };
}

function toInvoice(fields: Record<string, unknown>, sourcePath: string): Invoice | null {
  const invoiceNumber = asString(fields['invoiceNumber']);
  if (invoiceNumber === null) return null;
  const rawGoods = Array.isArray(fields['goods']) ? fields['goods'] : [];
  return { invoiceNumber, sourcePath, goods: rawGoods.map(toGood) };
}

function toCoa(fields: Record<string, unknown>, sourcePath: string): Coa | null {
  const batchNumber = asString(fields['batchNumber']);
  return batchNumber === null ? null : { batchNumber, sourcePath };
}

/** Two invoices are the same document when their number and their goods agree exactly. */
function invoiceFingerprint(invoice: Invoice): string {
  const goods = [...invoice.goods]
    .sort((a, b) => a.lineKey.localeCompare(b.lineKey))
    .map((good) =>
      [
        good.lineKey,
        good.batchNumber ?? '',
        good.htsCode ?? '',
        good.fdaProductCode ?? '',
        good.andaNumber ?? '',
        good.registrationNumber ?? '',
        good.ndcNumber ?? '',
      ].join('|'),
    );
  return [invoice.invoiceNumber, ...goods].join('\u0000');
}

interface DeduplicatedInvoices {
  invoices: Invoice[];
  /** Invoice numbers received more than once with identical content. */
  redelivered: string[];
  /** Invoice numbers received more than once with different content. */
  conflicting: string[];
}

export function deduplicateInvoices(raw: readonly Invoice[]): DeduplicatedInvoices {
  const byNumber = new Map<string, Invoice[]>();
  for (const invoice of raw) {
    const bucket = byNumber.get(invoice.invoiceNumber);
    if (bucket === undefined) byNumber.set(invoice.invoiceNumber, [invoice]);
    else bucket.push(invoice);
  }

  const invoices: Invoice[] = [];
  const redelivered: string[] = [];
  const conflicting: string[] = [];

  for (const number of [...byNumber.keys()].sort()) {
    const bucket = byNumber.get(number) ?? [];
    const fingerprints = new Set(bucket.map(invoiceFingerprint));
    invoices.push(bucket[0] as Invoice);
    if (bucket.length === 1) continue;
    if (fingerprints.size === 1) redelivered.push(number);
    else conflicting.push(number);
  }

  return { invoices, redelivered: redelivered.sort(), conflicting: conflicting.sort() };
}

interface CollectedDocuments {
  invoices: Invoice[];
  coas: Coa[];
  unreadable: string[];
  redelivered: string[];
  conflicting: string[];
}

async function readDocuments(
  context: AgentContext,
  attachments: readonly AttachmentRef[],
): Promise<CollectedDocuments> {
  const documents = context.toolRegistry.documents;
  const sorted = [...attachments].sort((a, b) => a.filename.localeCompare(b.filename));
  const classified: ClassifiedDocument[] = [];

  // Chunked rather than unbounded, and never `p-limit`: the workflow sandbox replays promise
  // resolution order, so bounded parallelism has to come from a deterministic partition.
  for (const group of chunk(sorted, Math.max(1, context.config.maxConcurrency))) {
    const texts = await Promise.all(
      group.map(async (attachment) => documents.extractText(fileRefOf(attachment))),
    );
    group.forEach((attachment, index) => {
      const text = texts[index] ?? '';
      classified.push({
        kind: text.trim().length < MIN_READABLE_CHARS ? 'unreadable' : classify(text),
        attachment,
        text,
      });
    });
  }

  const rawInvoices: Invoice[] = [];
  const coas: Coa[] = [];
  const unreadable: string[] = [];

  for (const document of classified) {
    const ref = fileRefOf(document.attachment);
    if (document.kind === 'unreadable') {
      unreadable.push(document.attachment.filename);
      continue;
    }
    if (document.kind === 'packingList') continue;

    const schemaName =
      document.kind === 'invoice' ? EXTRACTION_SCHEMA_INVOICE : EXTRACTION_SCHEMA_COA;
    const fields = await documents.extractFields(ref, schemaName);

    if (document.kind === 'invoice') {
      const invoice = toInvoice(fields, ref.storagePath);
      if (invoice === null) unreadable.push(document.attachment.filename);
      else rawInvoices.push(invoice);
    } else {
      const coa = toCoa(fields, ref.storagePath);
      if (coa === null) unreadable.push(document.attachment.filename);
      else coas.push(coa);
    }
  }

  const deduplicated = deduplicateInvoices(rawInvoices);
  return {
    invoices: deduplicated.invoices,
    coas: coas.sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
    unreadable: unreadable.sort(),
    redelivered: deduplicated.redelivered,
    conflicting: deduplicated.conflicting,
  };
}

function emptySummary(businessKey: string): AgentDecision['shipmentSummary'] {
  const isMawb = /^\d{3}-\d{8}$/.test(businessKey);
  return {
    containerNumber: isMawb ? null : businessKey,
    mawb: isMawb ? businessKey : null,
    invoiceNumbers: [],
    batchNumbers: [],
    goodsCount: 0,
    validGoodsCount: 0,
  };
}

function summaryFor(
  businessKey: string,
  documents: CollectedDocuments,
  assessment: ShipmentAssessment,
): AgentDecision['shipmentSummary'] {
  return {
    ...emptySummary(businessKey),
    invoiceNumbers: documents.invoices.map((invoice) => invoice.invoiceNumber).sort(),
    batchNumbers: [
      ...new Set(
        documents.invoices.flatMap((invoice) =>
          invoice.goods
            .map((good) => good.batchNumber)
            .filter((batch): batch is string => batch !== null),
        ),
      ),
    ].sort(),
    goodsCount: assessment.goodsCount,
    validGoodsCount: assessment.validGoodsCount,
  };
}

/** Ordinals are display-only; identity is always `step_instance_key`. */
const STAGE = { correlate: 2, extract: 10, validateBase: 1000, decide: 40, respond: 90 } as const;

async function escalate(
  context: AgentContext,
  businessKey: string,
  reason: string,
  summary: AgentDecision['shipmentSummary'],
  evidence: Record<string, unknown>,
): Promise<AgentDecision> {
  const stepInstanceKey = `escalate:${businessKey}`;
  const step = await context.recorder.startStep({
    nodeId: null,
    stepKey: 'escalate',
    stepInstanceKey,
    sequenceNo: STAGE.decide,
    inputSummary: { reason },
  });

  let decisionNotes: string | null = null;
  if (context.capabilities.includes('human.handoff')) {
    const requestId = await context.toolRegistry.humanHandoff.requestDecision(
      handoffQuestion(businessKey, reason),
      evidence,
    );
    const answer = await context.toolRegistry.humanHandoff.waitForDecision(requestId);
    decisionNotes = answer.notes ?? answer.decision;
  }

  await context.recorder.appendEvidence(
    step.stepExecutionId,
    { phase: 'escalation', reason, ...evidence },
    { eventKey: `escalation:${businessKey}` },
  );
  await context.recorder.completeStep(step.stepExecutionId, {
    reason,
    humanDecision: decisionNotes,
  });

  return {
    outcome: 'manual_review',
    businessKey,
    reason,
    shipmentSummary: summary,
    missingInformation: [],
    validationFailures: [],
    emailResponse: null,
  };
}

/**
 * Send the information request exactly once.
 *
 * The reservation is derived from the execution, the step instance, and the canonical payload, so
 * a replay after a crash finds the existing reservation rather than creating a second one. Meridian
 * provides replay deduplication and best-effort external exactly-once delivery; Gmail accepts no
 * idempotency token, so the honest claim stops there and the reconciliation path in the runtime
 * covers the remaining window.
 */
async function requestMissingInformation(
  context: AgentContext,
  businessKey: string,
  recipient: string,
  threadId: string | undefined,
  failures: readonly ValidationFailure[],
): Promise<AgentDecision['emailResponse']> {
  assertCapability(context, 'mail.send');

  const stepInstanceKey = `respond:${businessKey}`;
  const step = await context.recorder.startStep({
    nodeId: null,
    stepKey: 'respond',
    stepInstanceKey,
    sequenceNo: STAGE.respond,
    inputSummary: { failureCount: failures.length },
  });

  const email = {
    subject: missingInformationSubject(businessKey),
    body: missingInformationBody(businessKey, failures),
    recipient,
  };

  const action = await context.recorder.reserveAction(step.stepExecutionId, 'mail.send', {
    to: recipient,
    subject: email.subject,
    body: email.body,
    ...(threadId === undefined ? {} : { threadId }),
  });

  if (action.status === 'reserved') {
    await context.recorder.dispatchAction(action.executionActionId);
    const sent = await context.toolRegistry.mailbox.sendMessage({
      to: recipient,
      subject: email.subject,
      body: email.body,
      ...(threadId === undefined ? {} : { threadId }),
      markerToken: action.markerToken,
    });
    await context.recorder.completeAction(action.executionActionId, {
      status: 'succeeded',
      providerActionId: sent.providerMessageId,
      response: { threadId: sent.threadId },
    });
  }

  await context.recorder.completeStep(step.stepExecutionId, {
    executionActionId: action.executionActionId,
    recipient,
  });
  return email;
}

export const agent = defineAgent<ReceivingInput, AgentDecision>({
  deploymentKey: 'inbound-import-receiving',
  versionNo: 1,
  specHash: SPEC_HASH,
  inputSchema: InputSchema,
  decisionSchema: AgentDecisionSchema,

  async run(input, context) {
    const businessKey = input.businessKey;
    assertCapability(context, 'mail.read');
    assertCapability(context, 'document.extract');

    // -------------------------------------------------------------------------- correlate
    const threadIds = [...new Set(input.messages.map((message) => message.threadId))].sort();
    const correlateKey = `correlate:${businessKey}`;
    const correlateStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'correlate',
      stepInstanceKey: correlateKey,
      sequenceNo: STAGE.correlate,
      inputSummary: { threadIds, messageCount: input.messages.length },
    });

    const attachments: AttachmentRef[] = [];
    const seenAttachments = new Set<string>();
    for (const threadId of threadIds) {
      for (const attachment of await context.toolRegistry.mailbox.downloadAttachments(threadId)) {
        if (seenAttachments.has(attachment.attachmentId)) continue;
        seenAttachments.add(attachment.attachmentId);
        attachments.push(attachment);
      }
    }
    await context.recorder.completeStep(correlateStep.stepExecutionId, {
      attachmentCount: attachments.length,
      filenames: attachments.map((attachment) => attachment.filename).sort(),
    });

    // ---------------------------------------------------------------------------- extract
    const extractKey = `extract:${businessKey}`;
    const extractStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'extract',
      stepInstanceKey: extractKey,
      sequenceNo: STAGE.extract,
      inputSummary: { attachmentCount: attachments.length },
    });
    const documents = await readDocuments(context, attachments);
    await context.recorder.completeStep(extractStep.stepExecutionId, {
      invoiceNumbers: documents.invoices.map((invoice) => invoice.invoiceNumber).sort(),
      batchesCertified: documents.coas.map((coa) => coa.batchNumber),
      unreadable: documents.unreadable,
      redeliveredInvoices: documents.redelivered,
    });

    // A document the process cannot read is not an empty document. The specification does not say
    // what to do with one, so the run stops here rather than deciding on partial evidence.
    if (documents.unreadable.length > 0) {
      return escalate(
        context,
        businessKey,
        `${String(documents.unreadable.length)} attachment(s) could not be read: ${documents.unreadable.join(', ')}`,
        emptySummary(businessKey),
        { unreadable: documents.unreadable },
      );
    }

    // The Commercial invoice Input card is `required: true`. Without one there is nothing to
    // validate against, and inferring a shipment from certificates alone would be invention.
    if (documents.invoices.length === 0) {
      return escalate(
        context,
        businessKey,
        'no commercial invoice was present in the correlated messages',
        emptySummary(businessKey),
        { certifiedBatches: documents.coas.map((coa) => coa.batchNumber) },
      );
    }

    // ------------------------------------------------------------------- validate per good
    const plannedGoods = documents.invoices
      .flatMap((invoice) => invoice.goods.map((good) => ({ invoice: invoice.invoiceNumber, good })))
      .sort((left, right) =>
        `${left.invoice}\u0000${left.good.lineKey}`.localeCompare(
          `${right.invoice}\u0000${right.good.lineKey}`,
        ),
      );

    // Ordinals are assigned up front from the sorted list, before anything is scheduled, so
    // parallel siblings get stable display numbers without a runtime allocator to serialise on.
    const planned = plannedGoods.map((entry, index) => ({
      ...entry,
      sequenceNo: STAGE.validateBase + index + 1,
    }));

    for (const group of chunk(planned, Math.max(1, context.config.maxConcurrency))) {
      await Promise.all(
        group.map(async (entry) => {
          const stepInstanceKey = `validate-good:${entry.invoice}:${entry.good.lineKey}`;
          const step = await context.recorder.startStep({
            nodeId: null,
            stepKey: 'validate_good',
            stepInstanceKey,
            sequenceNo: entry.sequenceNo,
            inputSummary: { invoiceNumber: entry.invoice, lineKey: entry.good.lineKey },
          });
          const missing = assessShipment(
            [{ invoiceNumber: entry.invoice, sourcePath: '', goods: [entry.good] }],
            [],
          );
          await context.recorder.completeStep(step.stepExecutionId, {
            complete: missing.validGoodsCount === 1,
            missingFields: missing.failures.filter((f) => f.scope === 'good').map((f) => f.field),
          });
        }),
      );
    }

    // ------------------------------------------------------------------------------ decide
    const assessment = assessShipment(documents.invoices, documents.coas);
    const summary = summaryFor(businessKey, documents, assessment);

    const conflicting = documents.conflicting;
    const decideStep = await context.recorder.startStep({
      nodeId: null,
      stepKey: 'decide',
      stepInstanceKey: `decide:${businessKey}`,
      sequenceNo: STAGE.decide,
      inputSummary: { failureCount: assessment.failures.length, conflicting },
    });

    let outcome: AgentDecision['outcome'];
    let reason: string;

    if (conflicting.length > 0) {
      outcome = 'rejected';
      reason = `invoice ${conflicting.join(', ')} was received twice with different contents`;
    } else if (assessment.duplicateInvoices.length > 0 || assessment.duplicateBatches.length > 0) {
      outcome = 'rejected';
      reason =
        assessment.duplicateBatches.length > 0
          ? `batch ${assessment.duplicateBatches.join(', ')} appears on more than one invoice`
          : `invoice ${assessment.duplicateInvoices.join(', ')} appears more than once`;
    } else if (assessment.failures.length > 0) {
      outcome = 'needs_information';
      reason = `${String(assessment.failures.length)} validation failure(s) require the forwarder to respond`;
    } else if (documents.redelivered.length > 0 && input.messages.length > 1) {
      // Every later message repeated a document already held. There is nothing new to receive.
      outcome = 'completed';
      reason = `invoice ${documents.redelivered.join(', ')} was already received on this shipment`;
    } else {
      outcome = 'ready';
      reason = 'every good carries the required fields and every batch has exactly one certificate';
    }

    await context.recorder.appendEvidence(
      decideStep.stepExecutionId,
      {
        phase: 'assessment',
        outcome,
        failures: assessment.failures,
        redelivered: documents.redelivered,
        conflicting,
      },
      { eventKey: `assessment:${businessKey}` },
    );
    await context.recorder.completeStep(decideStep.stepExecutionId, { outcome, reason });

    // ----------------------------------------------------------------------------- respond
    let emailResponse: AgentDecision['emailResponse'] = null;
    if (outcome === 'needs_information') {
      // The reply goes onto the original thread, so Gmail addresses the forwarder. The explicit
      // recipient is the operator mailbox rather than a sender address parsed out of the message,
      // because the live adapter checks it against `GMAIL_ALLOWED_RECIPIENTS` and a parsed address
      // is exactly the value an attacker would control.
      const recipient = context.config.operatorEmail;
      emailResponse = await requestMissingInformation(
        context,
        businessKey,
        recipient,
        threadIds[0],
        assessment.failures,
      );
    }

    return {
      outcome,
      businessKey,
      reason,
      shipmentSummary: summary,
      missingInformation: missingInformationList(assessment.failures),
      validationFailures: assessment.failures,
      emailResponse,
    };
  },
});

export default agent;
