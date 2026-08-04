import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repoPath } from '../lib/state.js';

/**
 * Regenerate the two example boards.
 *
 * The boards are checked in rather than built at test time, because a fixture that is regenerated
 * on every run cannot catch an accidental change to the compiler or the hash — the fixture would
 * simply move with it. This script exists so the checked-in files can be reproduced and reviewed,
 * not so they can be produced on demand.
 *
 * Every identifier is a UUIDv5-shaped hash of a stable slug, so re-running produces byte-identical
 * output and a node keeps its ID across regenerations.
 */

const NAMESPACE = 'meridian.examples.inbound-import-receiving';

/**
 * A UUIDv5-shaped hash of a slug within a namespace. The namespace is a parameter because a second
 * example board needs its own identifier space: two boards that both contain a card slugged
 * `action-fetch-thread` must not end up sharing a node ID.
 */
export function stableUuidIn(namespace: string, slug: string): string {
  const digest = createHash('sha1').update(`${namespace}:${slug}`).digest();
  // Stamp version 5 and the RFC 4122 variant so the value is a well-formed UUID rather than a
  // hex string that merely looks like one; the database column would reject the latter.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function stableUuid(slug: string): string {
  return stableUuidIn(NAMESPACE, slug);
}

export interface SeedNode {
  nodeId: string;
  primitiveType: 'input' | 'action' | 'rule' | 'outcome';
  title: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface SeedEdge {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  condition: Record<string, unknown> | null;
  priority: number;
}

export interface SeedBoard {
  /**
   * Named rather than server-assigned, because it is hashed.
   *
   * The canonical snapshot carries `metadata.whiteboardId`, so a board that took a fresh UUID on
   * every seed would produce a different canvas hash and a different `spec_hash` on every machine,
   * and the `spec.snapshot.json` checked in beside the generated agent could not correspond to any
   * freeze but the one that happened to produce it.
   */
  whiteboardId: string;
  title: string;
  viewport: { x: number; y: number; zoom: number };
  nodes: SeedNode[];
  edges: SeedEdge[];
}

const n = stableUuid;

// ------------------------------------------------------------------ the receiving board

const ID = {
  arrival: n('input-arrival-notice'),
  invoice: n('input-commercial-invoice'),
  coa: n('input-certificate-of-analysis'),
  fetch: n('action-fetch-thread'),
  extract: n('action-extract-documents'),
  retry: n('rule-extraction-retry'),
  key: n('rule-business-key'),
  duplicate: n('rule-duplicate-invoice'),
  fields: n('rule-required-product-fields'),
  coaMatch: n('rule-coa-per-batch'),
  request: n('action-request-missing-information'),
  wait: n('rule-wait-for-reply'),
  failure: n('rule-unexpected-failure'),
  escalate: n('action-escalate-to-specialist'),
  ready: n('outcome-ready'),
  needsInfo: n('outcome-needs-information'),
  manual: n('outcome-manual-review'),
  rejected: n('outcome-rejected'),
  completed: n('outcome-completed'),
} as const;

function edge(
  slug: string,
  source: string,
  target: string,
  label: string | null,
  priority = 0,
): SeedEdge {
  return {
    edgeId: n(`edge-${slug}`),
    sourceNodeId: source,
    targetNodeId: target,
    label,
    condition: null,
    priority,
  };
}

export function receivingBoard(): SeedBoard {
  const nodes: SeedNode[] = [
    {
      nodeId: ID.arrival,
      primitiveType: 'input',
      title: 'Pre-alert documentation email',
      data: {
        inputKind: 'event',
        sourceSystem: 'Gmail',
        required: true,
        fields: [
          {
            name: 'subject',
            type: 'string',
            required: true,
            description:
              'Forwarder subject line. The process only looks at a message whose subject contains "Pre-Alert Documents" or "APL USA // PRE-ALERT DOCUMENTATION".',
          },
          { name: 'body', type: 'string', required: true, description: 'Plain-text body.' },
          {
            name: 'receivedAt',
            type: 'date',
            required: true,
            description: 'Provider receipt timestamp.',
          },
        ],
        correlationKeys: ['containerNumber', 'mawb'],
      },
      position: { x: 0, y: 0 },
    },
    {
      nodeId: ID.invoice,
      primitiveType: 'input',
      title: 'Commercial invoice',
      data: {
        inputKind: 'document',
        sourceSystem: 'Email attachment',
        required: true,
        fields: [
          {
            name: 'invoiceNumber',
            type: 'string',
            required: true,
            description: 'Seller invoice number.',
          },
          {
            name: 'htsCode',
            type: 'string',
            required: true,
            description: 'Harmonized tariff code per good.',
          },
          {
            name: 'fdaProductCode',
            type: 'string',
            required: true,
            description: 'FDA product code per good.',
          },
          {
            name: 'andaNumber',
            type: 'string',
            required: true,
            description: 'ANDA number per good.',
          },
          {
            name: 'registrationNumber',
            type: 'string',
            required: false,
            description:
              'FDA establishment registration number per good. Captured and reported; receiving is never held for it.',
          },
          {
            name: 'ndcNumber',
            type: 'string',
            required: true,
            description: 'National drug code per good.',
          },
          {
            name: 'batchNumber',
            type: 'string',
            required: true,
            description: 'Batch identifier per good.',
          },
        ],
        correlationKeys: ['invoiceNumber'],
      },
      position: { x: 0, y: 160 },
    },
    {
      nodeId: ID.coa,
      primitiveType: 'input',
      title: 'Certificate of analysis',
      data: {
        inputKind: 'document',
        sourceSystem: 'Email attachment',
        required: true,
        fields: [
          {
            name: 'batchNumber',
            type: 'string',
            required: true,
            description: 'Batch the certificate covers.',
          },
        ],
        correlationKeys: ['batchNumber'],
      },
      position: { x: 0, y: 480 },
    },
    {
      nodeId: ID.fetch,
      primitiveType: 'action',
      title: 'Fetch the thread and download attachments',
      data: {
        actor: 'agent',
        operation: 'mail.read',
        instructions:
          'Read every message on the thread and download each attachment to durable storage before extracting anything.',
        system: 'Gmail',
        inputs: ['Arrival notice email'],
        outputs: ['Thread messages', 'Stored attachments'],
      },
      position: { x: 280, y: 0 },
    },
    {
      nodeId: ID.extract,
      primitiveType: 'action',
      title: 'Extract fields from every attachment',
      data: {
        actor: 'agent',
        operation: 'document.extract',
        instructions:
          'Extract the commercial invoice and certificate of analysis fields. Record the extracted values as evidence against the document they came from.',
        system: 'Document extraction service',
        inputs: ['Stored attachments'],
        outputs: ['Invoice fields', 'Certificate fields'],
      },
      position: { x: 560, y: 240 },
    },
    {
      nodeId: ID.retry,
      primitiveType: 'rule',
      title: 'Retry a transient extraction failure',
      data: {
        ruleKind: 'retry',
        condition: 'The extraction tool returned a retryable error.',
        branches: [],
        maxAttempts: 3,
        fallbackNodeId: null,
      },
      position: { x: 840, y: 240 },
    },
    {
      nodeId: ID.key,
      primitiveType: 'rule',
      title: 'Is a shipment business key present?',
      data: {
        ruleKind: 'decision',
        condition:
          'A valid ISO 6346 container number or a valid IATA master air waybill appears in the subject, the body, or an attachment. Where neither does, the invoice number the SOP reports against is used instead.',
        branches: [
          {
            label: 'transport key found',
            condition: 'Exactly one valid container number or master air waybill was found.',
            targetNodeId: ID.extract,
          },
          {
            label: 'invoice number used instead',
            condition:
              'No container number or master air waybill was found, and exactly one invoice number was.',
            targetNodeId: ID.extract,
          },
          {
            label: 'no usable business key',
            condition:
              'Nothing identified the shipment, or two different keys of the same kind conflict.',
            targetNodeId: ID.manual,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 560, y: 0 },
    },
    {
      nodeId: ID.duplicate,
      primitiveType: 'rule',
      title: 'Has this invoice already been received?',
      data: {
        ruleKind: 'decision',
        condition:
          'The invoice number is compared against the invoices already recorded for this shipment.',
        branches: [
          {
            label: 'invoice not seen before',
            condition: 'The invoice number is new for this shipment.',
            targetNodeId: ID.fields,
          },
          {
            label: 'invoice already received on this shipment',
            condition: 'The invoice number matches one already recorded for this shipment.',
            targetNodeId: ID.completed,
          },
          {
            label: 'invoice belongs to a different shipment',
            condition: 'The invoice number is recorded against a different business key.',
            targetNodeId: ID.rejected,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1120, y: 240 },
    },
    {
      nodeId: ID.fields,
      primitiveType: 'rule',
      title: 'Does every good carry the four required fields?',
      data: {
        ruleKind: 'decision',
        condition:
          'Each line item in the Description of Goods must carry an HTS number, an FDA product code, an NDC number, and an ANDA number.',
        branches: [
          {
            label: 'all required product fields present',
            condition: 'Every good on every invoice carries all four fields.',
            targetNodeId: ID.coaMatch,
          },
          {
            label: 'required product fields missing',
            condition: 'At least one good is missing at least one of the four fields.',
            targetNodeId: ID.request,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1400, y: 160 },
    },
    {
      nodeId: ID.coaMatch,
      primitiveType: 'rule',
      title: 'Does each batch have exactly one certificate of analysis?',
      data: {
        ruleKind: 'decision',
        condition:
          'Every batch named on an invoice must be covered by exactly one certificate of analysis, and every certificate must name a batch that appears on an invoice.',
        branches: [
          {
            label: 'exactly one certificate per batch',
            condition: 'The batch set and the certificate set match one to one.',
            targetNodeId: ID.ready,
          },
          {
            label: 'certificate missing or ambiguous',
            condition:
              'A batch has no certificate, more than one certificate, or a certificate names an unknown batch.',
            targetNodeId: ID.request,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1680, y: 160 },
    },
    {
      nodeId: ID.request,
      primitiveType: 'action',
      title: 'Ask the forwarder for the missing information',
      data: {
        actor: 'agent',
        operation: 'mail.send',
        instructions:
          'Reply on the original thread naming every missing field and every batch without a certificate. Send exactly one request per shipment per round.',
        system: 'Gmail',
        inputs: ['Missing field list', 'Unmatched batch list'],
        outputs: ['Sent request'],
      },
      position: { x: 1400, y: 400 },
    },
    {
      nodeId: ID.wait,
      primitiveType: 'rule',
      title: 'Wait for the forwarder to reply',
      data: {
        ruleKind: 'wait',
        condition: 'A reply arrives on the same thread carrying the requested information.',
        branches: [],
        timeoutMinutes: 2880,
        fallbackNodeId: null,
      },
      position: { x: 1400, y: 560 },
    },
    {
      nodeId: ID.failure,
      primitiveType: 'rule',
      title: 'Escalate an unexpected failure',
      data: {
        ruleKind: 'exception',
        condition:
          'Extraction exhausted its retries, or a tool failed in a way the process does not define.',
        branches: [],
        fallbackNodeId: ID.manual,
      },
      position: { x: 840, y: 480 },
    },
    {
      nodeId: ID.escalate,
      primitiveType: 'action',
      title: 'Escalate to a receiving specialist',
      data: {
        actor: 'human',
        operation: 'human.handoff',
        instructions:
          'Give the specialist the thread, the stored attachments, and the reason the automated path stopped.',
        system: '',
        inputs: ['Thread', 'Stored attachments', 'Stop reason'],
        outputs: ['Specialist decision'],
      },
      position: { x: 840, y: 640 },
    },
    {
      nodeId: ID.ready,
      primitiveType: 'outcome',
      title: 'Ready to receive',
      data: { resultKind: 'ready', terminal: true },
      position: { x: 2240, y: 160 },
    },
    {
      nodeId: ID.needsInfo,
      primitiveType: 'outcome',
      title: 'Waiting on missing information',
      data: {
        resultKind: 'needs_information',
        terminal: true,
        requiredAction: {
          actionType: 'mail.send',
          description: 'A request has been sent and no reply arrived before the deadline.',
          capability: 'mail.send',
        },
      },
      position: { x: 1680, y: 640 },
    },
    {
      nodeId: ID.manual,
      primitiveType: 'outcome',
      title: 'Manual review required',
      data: {
        resultKind: 'manual_review',
        terminal: true,
        requiredAction: {
          actionType: 'human.handoff',
          description: 'A receiving specialist must decide how to proceed.',
          capability: 'human.handoff',
        },
      },
      position: { x: 1120, y: 640 },
    },
    {
      nodeId: ID.rejected,
      primitiveType: 'outcome',
      title: 'Rejected as inconsistent',
      data: { resultKind: 'rejected', terminal: true },
      position: { x: 1400, y: 800 },
    },
    {
      nodeId: ID.completed,
      primitiveType: 'outcome',
      title: 'Already received',
      data: { resultKind: 'completed', terminal: true },
      position: { x: 1680, y: 800 },
    },
  ];

  const edges: SeedEdge[] = [
    edge('arrival-fetch', ID.arrival, ID.fetch, 'arrival notice received'),
    edge('invoice-extract', ID.invoice, ID.extract, 'invoice attached'),
    edge('coa-extract', ID.coa, ID.extract, 'certificate attached'),
    edge('fetch-key', ID.fetch, ID.key, 'thread downloaded'),
    edge('key-extract', ID.key, ID.extract, 'transport key found', 0),
    edge('key-invoice-extract', ID.key, ID.extract, 'invoice number used instead', 1),
    edge('key-manual', ID.key, ID.manual, 'no usable business key', 2),
    edge('extract-retry', ID.extract, ID.retry, 'extraction attempted'),
    edge('retry-duplicate', ID.retry, ID.duplicate, 'extraction succeeded', 0),
    edge(
      'retry-failure',
      ID.retry,
      ID.failure,
      'extraction still failing after the last attempt',
      1,
    ),
    edge('duplicate-fields', ID.duplicate, ID.fields, 'invoice not seen before', 0),
    edge(
      'duplicate-completed',
      ID.duplicate,
      ID.completed,
      'invoice already received on this shipment',
      1,
    ),
    edge(
      'duplicate-rejected',
      ID.duplicate,
      ID.rejected,
      'invoice belongs to a different shipment',
      2,
    ),
    edge('fields-coa', ID.fields, ID.coaMatch, 'all required product fields present', 0),
    edge('fields-request', ID.fields, ID.request, 'required product fields missing', 1),
    edge('coa-ready', ID.coaMatch, ID.ready, 'exactly one certificate per batch', 0),
    edge('coa-request', ID.coaMatch, ID.request, 'certificate missing or ambiguous', 1),
    edge('request-wait', ID.request, ID.wait, 'request sent'),
    edge('wait-extract', ID.wait, ID.extract, 'reply received with the missing information', 0),
    edge('wait-needs-info', ID.wait, ID.needsInfo, 'no reply before the deadline', 1),
    edge('failure-escalate', ID.failure, ID.escalate, 'unexpected failure raised'),
    edge('escalate-manual', ID.escalate, ID.manual, 'specialist takes over'),
  ];

  return {
    whiteboardId: n('whiteboard-inbound-import-receiving'),
    title: 'Inbound Import Receiving',
    viewport: { x: 0, y: 0, zoom: 0.6 },
    nodes,
    edges,
  };
}

// -------------------------------------------------------------------- the scale-100 board

/**
 * A board with one hundred nodes, used to prove the delta path, the review path, and the compiler
 * stay within budget at a size a real process reaches.
 *
 * The shape is a fan-out of per-good validation branches rather than a hundred unrelated cards,
 * because contention and snapshot size scale with edges, and a disconnected pile of cards would
 * exercise neither.
 */
export function scaleBoard(goodsCount = 48): SeedBoard {
  const s = (slug: string): string => stableUuid(`scale:${slug}`);
  const nodes: SeedNode[] = [];
  const edges: SeedEdge[] = [];

  const inputId = s('input');
  const fanId = s('fan-out');
  const joinId = s('join');
  const readyId = s('outcome-ready');
  const reviewId = s('outcome-manual-review');

  nodes.push({
    nodeId: inputId,
    primitiveType: 'input',
    title: 'Consolidated shipment manifest',
    data: {
      inputKind: 'document',
      sourceSystem: 'Email attachment',
      required: true,
      fields: [
        { name: 'invoiceNumber', type: 'string', required: true, description: 'Invoice number.' },
      ],
      correlationKeys: ['containerNumber'],
    },
    position: { x: 0, y: 0 },
  });

  nodes.push({
    nodeId: fanId,
    primitiveType: 'action',
    title: 'Split the manifest into goods',
    data: {
      actor: 'agent',
      operation: 'document.extract',
      instructions: 'Produce one validation branch per good on the manifest.',
      system: 'Document extraction service',
      inputs: ['Consolidated shipment manifest'],
      outputs: ['Goods list'],
    },
    position: { x: 240, y: 0 },
  });
  edges.push(edge('scale-input-fan', inputId, fanId, 'manifest received'));

  for (let index = 0; index < goodsCount; index += 1) {
    const label = String(index + 1).padStart(3, '0');
    const actionId = s(`validate-${label}`);
    const ruleId = s(`decide-${label}`);
    const row = index * 120;

    nodes.push({
      nodeId: actionId,
      primitiveType: 'action',
      title: `Validate good ${label}`,
      data: {
        actor: 'agent',
        operation: 'document.extract',
        instructions: `Read the five required regulatory fields for good ${label}.`,
        system: 'Document extraction service',
        inputs: ['Goods list'],
        outputs: [`Good ${label} fields`],
      },
      position: { x: 520, y: row },
    });

    nodes.push({
      nodeId: ruleId,
      primitiveType: 'rule',
      title: `Is good ${label} complete?`,
      data: {
        ruleKind: 'decision',
        condition: `Good ${label} carries all five required regulatory fields.`,
        branches: [
          { label: 'complete', condition: 'All five fields are present.', targetNodeId: joinId },
          {
            label: 'incomplete',
            condition: 'At least one field is missing.',
            targetNodeId: reviewId,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 800, y: row },
    });

    edges.push(edge(`scale-fan-${label}`, fanId, actionId, `good ${label}`, index));
    edges.push(edge(`scale-action-rule-${label}`, actionId, ruleId, 'fields read'));
    edges.push(edge(`scale-rule-join-${label}`, ruleId, joinId, 'complete', 0));
    edges.push(edge(`scale-rule-review-${label}`, ruleId, reviewId, 'incomplete', 1));
  }

  nodes.push({
    nodeId: joinId,
    primitiveType: 'action',
    title: 'Assemble the shipment summary',
    data: {
      actor: 'agent',
      operation: 'summarise shipment',
      instructions: 'Combine every completed good into one shipment summary.',
      system: 'Warehouse management system',
      inputs: ['Per-good results'],
      outputs: ['Shipment summary'],
    },
    position: { x: 1080, y: 0 },
  });
  nodes.push({
    nodeId: readyId,
    primitiveType: 'outcome',
    title: 'Ready to receive',
    data: { resultKind: 'ready', terminal: true },
    position: { x: 1360, y: 0 },
  });
  nodes.push({
    nodeId: reviewId,
    primitiveType: 'outcome',
    title: 'Manual review required',
    data: {
      resultKind: 'manual_review',
      terminal: true,
      requiredAction: {
        actionType: 'human.handoff',
        description: 'A specialist resolves the incomplete goods.',
        capability: 'human.handoff',
      },
    },
    position: { x: 1360, y: 200 },
  });
  edges.push(edge('scale-join-ready', joinId, readyId, 'summary assembled'));

  return {
    whiteboardId: n('whiteboard-inbound-import-receiving-scale'),
    title: 'Inbound Import Receiving at scale',
    viewport: { x: 0, y: 0, zoom: 0.25 },
    nodes,
    edges,
  };
}

export const SEED_PATH = 'examples/inbound-import-receiving/board.seed.json';
export const SCALE_PATH = 'examples/inbound-import-receiving/board.scale-100.json';

export async function main(_argv: readonly string[] = []): Promise<void> {
  const seed = receivingBoard();
  const scale = scaleBoard();
  writeFileSync(repoPath(SEED_PATH), `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  writeFileSync(repoPath(SCALE_PATH), `${JSON.stringify(scale, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify(
      {
        seed: { path: SEED_PATH, nodes: seed.nodes.length, edges: seed.edges.length },
        scale: { path: SCALE_PATH, nodes: scale.nodes.length, edges: scale.edges.length },
      },
      null,
      2,
    )}\n`,
  );
}
