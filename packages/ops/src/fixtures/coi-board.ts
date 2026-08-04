import { writeFileSync } from 'node:fs';
import { repoPath } from '../lib/state.js';
import { type SeedBoard, type SeedEdge, type SeedNode, stableUuidIn } from './boards.js';

/**
 * The second worked example: checking a vendor's certificate of insurance at renewal.
 *
 * It exists to be unlike the first one. Nothing here is a shipment, a batch, or a regulatory
 * identifier; the nouns are vendors, policies, coverage, and expiry dates, and the process rejects
 * for reasons the receiving board has no concept of. What it shares with the first board is only
 * the four primitives and the four capabilities — which is the claim being tested. If the platform
 * had an opinion about shipments anywhere in it, this board could not compile.
 *
 * It is deliberately smaller than the receiving board. A second example that took as long to read
 * as the first would not get read, and the point it makes does not need scale to make it.
 */

const NAMESPACE = 'meridian.examples.vendor-coi-renewal';
const n = (slug: string): string => stableUuidIn(NAMESPACE, slug);

const ID = {
  request: n('input-renewal-request'),
  certificate: n('input-certificate-of-insurance'),
  fetch: n('action-fetch-thread'),
  extract: n('action-extract-certificate'),
  retry: n('rule-extraction-retry'),
  vendor: n('rule-vendor-identified'),
  complete: n('rule-certificate-complete'),
  coverage: n('rule-coverage-meets-minimum'),
  inForce: n('rule-policy-in-force'),
  ask: n('action-ask-vendor'),
  wait: n('rule-wait-for-vendor'),
  failure: n('rule-unexpected-failure'),
  escalate: n('action-escalate-to-risk'),
  accepted: n('outcome-accepted'),
  waiting: n('outcome-waiting-on-vendor'),
  review: n('outcome-risk-review'),
  rejected: n('outcome-rejected'),
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

export function coiBoard(): SeedBoard {
  const nodes: SeedNode[] = [
    {
      nodeId: ID.request,
      primitiveType: 'input',
      title: 'Renewal request email',
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
              'Vendor subject line. The process only looks at a message whose subject contains "Certificate of Insurance".',
          },
          { name: 'body', type: 'string', required: true, description: 'Plain-text body.' },
          {
            name: 'receivedAt',
            type: 'date',
            required: true,
            description: 'Provider receipt timestamp.',
          },
        ],
        correlationKeys: ['vendorId'],
      },
      position: { x: 0, y: 0 },
    },
    {
      nodeId: ID.certificate,
      primitiveType: 'input',
      title: 'Certificate of insurance',
      data: {
        inputKind: 'document',
        sourceSystem: 'Email attachment',
        required: true,
        fields: [
          {
            name: 'policyNumber',
            type: 'string',
            required: true,
            description: 'Insurer policy number.',
          },
          { name: 'insurerName', type: 'string', required: true, description: 'Carrier name.' },
          {
            name: 'coverageAmount',
            type: 'number',
            required: true,
            description: 'General liability limit in USD.',
          },
          {
            name: 'expiryDate',
            type: 'date',
            required: true,
            description: 'Date the policy lapses.',
          },
          {
            name: 'additionalInsured',
            type: 'string',
            required: false,
            description:
              'Named additional insured, where the carrier lists one. Recorded, never a reason to reject.',
          },
        ],
        correlationKeys: ['policyNumber'],
      },
      position: { x: 0, y: 200 },
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
        inputs: ['Renewal request email'],
        outputs: ['Thread messages', 'Stored attachments'],
      },
      position: { x: 280, y: 0 },
    },
    {
      nodeId: ID.extract,
      primitiveType: 'action',
      title: 'Extract the certificate fields',
      data: {
        actor: 'agent',
        operation: 'document.extract',
        instructions:
          'Extract the policy number, insurer, coverage limit, and expiry date. Record the extracted values as evidence against the document they came from.',
        system: 'Document extraction service',
        inputs: ['Stored attachments'],
        outputs: ['Certificate fields'],
      },
      position: { x: 560, y: 200 },
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
      position: { x: 840, y: 200 },
    },
    {
      nodeId: ID.vendor,
      primitiveType: 'rule',
      title: 'Is the vendor identified?',
      data: {
        ruleKind: 'decision',
        condition:
          'A known vendor account number appears in the subject, the body, or the certificate.',
        branches: [
          {
            label: 'vendor identified',
            condition: 'Exactly one vendor account number was found.',
            targetNodeId: ID.extract,
          },
          {
            label: 'vendor not identified',
            condition: 'No vendor account number was found, or two different ones conflict.',
            targetNodeId: ID.review,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 560, y: 0 },
    },
    {
      nodeId: ID.complete,
      primitiveType: 'rule',
      title: 'Does the certificate carry every required field?',
      data: {
        ruleKind: 'decision',
        condition:
          'The certificate must state a policy number, an insurer, a coverage amount, and an expiry date.',
        branches: [
          {
            label: 'certificate complete',
            condition: 'All four fields are present.',
            targetNodeId: ID.coverage,
          },
          {
            label: 'certificate incomplete',
            condition: 'At least one of the four fields is absent.',
            targetNodeId: ID.ask,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1120, y: 120 },
    },
    {
      nodeId: ID.coverage,
      primitiveType: 'rule',
      title: 'Does coverage meet the contracted minimum?',
      data: {
        ruleKind: 'decision',
        condition: 'General liability coverage must be at least USD 1,000,000.',
        branches: [
          {
            label: 'coverage sufficient',
            condition: 'The stated limit is at least the contracted minimum.',
            targetNodeId: ID.inForce,
          },
          {
            label: 'coverage below minimum',
            condition: 'The stated limit is below the contracted minimum.',
            targetNodeId: ID.rejected,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1400, y: 120 },
    },
    {
      nodeId: ID.inForce,
      primitiveType: 'rule',
      title: 'Is the policy still in force?',
      data: {
        ruleKind: 'decision',
        condition: 'The expiry date must be on or after the renewal date the request names.',
        branches: [
          {
            label: 'policy in force',
            condition: 'The certificate does not expire before the renewal date.',
            targetNodeId: ID.accepted,
          },
          {
            label: 'policy already lapsed',
            condition: 'The certificate expires before the renewal date.',
            targetNodeId: ID.ask,
          },
        ],
        fallbackNodeId: null,
      },
      position: { x: 1680, y: 120 },
    },
    {
      nodeId: ID.ask,
      primitiveType: 'action',
      title: 'Ask the vendor for a corrected certificate',
      data: {
        actor: 'agent',
        operation: 'mail.send',
        instructions:
          'Reply on the original thread naming the policy number and every field that is missing or out of date. Send exactly one request per renewal per round.',
        system: 'Gmail',
        inputs: ['Certificate findings'],
        outputs: ['Sent request'],
      },
      position: { x: 1400, y: 400 },
    },
    {
      nodeId: ID.wait,
      primitiveType: 'rule',
      title: 'Wait for the vendor to reply',
      data: {
        ruleKind: 'wait',
        condition: 'A reply arrives on the same thread carrying a corrected certificate.',
        branches: [],
        timeoutMinutes: 4320,
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
        fallbackNodeId: ID.review,
      },
      position: { x: 840, y: 420 },
    },
    {
      nodeId: ID.escalate,
      primitiveType: 'action',
      title: 'Escalate to a risk reviewer',
      data: {
        actor: 'human',
        operation: 'human.handoff',
        instructions:
          'Give the reviewer the thread, the stored certificate, and the reason the automated path stopped.',
        system: '',
        inputs: ['Thread', 'Stored attachments', 'Stop reason'],
        outputs: ['Reviewer decision'],
      },
      position: { x: 840, y: 580 },
    },
    {
      nodeId: ID.accepted,
      primitiveType: 'outcome',
      title: 'Certificate accepted',
      data: { resultKind: 'ready', terminal: true },
      position: { x: 1960, y: 120 },
    },
    {
      nodeId: ID.waiting,
      primitiveType: 'outcome',
      title: 'Waiting on a corrected certificate',
      data: {
        resultKind: 'needs_information',
        terminal: true,
        requiredAction: {
          actionType: 'mail.send',
          description: 'A request has been sent and no corrected certificate arrived in time.',
          capability: 'mail.send',
        },
      },
      position: { x: 1680, y: 560 },
    },
    {
      nodeId: ID.review,
      primitiveType: 'outcome',
      title: 'Risk review required',
      data: {
        resultKind: 'manual_review',
        terminal: true,
        requiredAction: {
          actionType: 'human.handoff',
          description: 'A risk reviewer must decide how to proceed.',
          capability: 'human.handoff',
        },
      },
      position: { x: 1120, y: 580 },
    },
    {
      nodeId: ID.rejected,
      primitiveType: 'outcome',
      title: 'Certificate rejected',
      data: { resultKind: 'rejected', terminal: true },
      position: { x: 1400, y: 720 },
    },
  ];

  const edges: SeedEdge[] = [
    edge('request-fetch', ID.request, ID.fetch, 'renewal request received'),
    edge('certificate-extract', ID.certificate, ID.extract, 'certificate attached'),
    edge('fetch-vendor', ID.fetch, ID.vendor, 'thread downloaded'),
    edge('vendor-extract', ID.vendor, ID.extract, 'vendor identified', 0),
    edge('vendor-review', ID.vendor, ID.review, 'vendor not identified', 1),
    edge('extract-retry', ID.extract, ID.retry, 'extraction attempted'),
    edge('retry-complete', ID.retry, ID.complete, 'extraction succeeded', 0),
    edge(
      'retry-failure',
      ID.retry,
      ID.failure,
      'extraction still failing after the last attempt',
      1,
    ),
    edge('complete-coverage', ID.complete, ID.coverage, 'certificate complete', 0),
    edge('complete-ask', ID.complete, ID.ask, 'certificate incomplete', 1),
    edge('coverage-inforce', ID.coverage, ID.inForce, 'coverage sufficient', 0),
    edge('coverage-rejected', ID.coverage, ID.rejected, 'coverage below minimum', 1),
    edge('inforce-accepted', ID.inForce, ID.accepted, 'policy in force', 0),
    edge('inforce-ask', ID.inForce, ID.ask, 'policy already lapsed', 1),
    edge('ask-wait', ID.ask, ID.wait, 'request sent'),
    edge('wait-extract', ID.wait, ID.extract, 'corrected certificate received', 0),
    edge('wait-waiting', ID.wait, ID.waiting, 'no reply before the deadline', 1),
    edge('failure-escalate', ID.failure, ID.escalate, 'unexpected failure raised'),
    edge('escalate-review', ID.escalate, ID.review, 'reviewer takes over'),
  ];

  return {
    whiteboardId: n('whiteboard-vendor-coi-renewal'),
    title: 'Vendor Insurance Certificate Renewal',
    viewport: { x: 0, y: 0, zoom: 0.6 },
    nodes,
    edges,
  };
}

export const COI_SEED_PATH = 'examples/vendor-coi-renewal/board.seed.json';

export async function main(_argv: readonly string[] = []): Promise<void> {
  const board = coiBoard();
  writeFileSync(repoPath(COI_SEED_PATH), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify(
      { path: COI_SEED_PATH, nodes: board.nodes.length, edges: board.edges.length },
      null,
      2,
    )}\n`,
  );
}
