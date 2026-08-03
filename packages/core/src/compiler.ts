import {
  deriveInitialNodeIds,
  deriveTerminalNodeIds,
  reachableFrom,
  validateGraphIntegrity,
} from './graph.js';
import { sha256Hex } from './hashing.js';
import type { CanonicalGraph } from './schemas/board.js';
import {
  ActionDataSchema,
  InputDataSchema,
  OutcomeDataSchema,
  RuleDataSchema,
} from './schemas/primitives.js';
import type { Severity } from './schemas/review.js';
import {
  isKnownCapability,
  KNOWN_CAPABILITIES,
  looksLikeCapability,
  SpecJsonSchema,
  type Capability,
  type SpecAssumption,
  type SpecJson,
  type SpecKnownGap,
  type SpecNode,
  type SpecTransition,
} from './schemas/spec.js';

export type CompilerErrorCode =
  | 'MISSING_REFERENCE'
  | 'NO_INITIAL_PATH'
  | 'NO_TERMINAL_PATH'
  | 'DUPLICATE_ID'
  | 'INVALID_CARD_DATA'
  | 'UNKNOWN_CAPABILITY';

export interface CompilerError {
  code: CompilerErrorCode;
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/**
 * A live (non-superseded) assumption, read from `comments.metadata_json`. `sourceRootCommentId`
 * is the **root issue** the assumption answers, never the assumption reply's own ID (§5.5.4).
 */
export interface CompilerAssumption {
  assumptionText: string;
  sourceRootCommentId: string;
}

export interface CompilerKnownGap {
  text: string;
  severity: Severity;
  sourceCommentId: string;
}

export interface CompileSpecInput {
  graph: CanonicalGraph;
  specId: string;
  specVersion: number;
  name: string;
  canvasHash: string;
  reviewSessionIds: readonly string[];
  frozenAt: string;
  acknowledgedUnresolvedBlockers: boolean;
  acknowledgedStaleReview: boolean;
  assumptions: readonly CompilerAssumption[];
  knownGaps: readonly CompilerKnownGap[];
}

export type CompileSpecResult = { specJson: SpecJson } | { errors: CompilerError[] };

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The part of `spec_json` that `spec_hash` is taken over.
 *
 * `spec_hash` answers "is this the same contract", so it covers what the contract says and not the
 * circumstances of the freeze that recorded it. Held out are `identity.specId` (minted per freeze),
 * `identity.specVersion` (a count of freezes), `source.frozenAt` (a clock reading),
 * `source.reviewSessionIds` (which rounds happened to look at the board), and the two
 * acknowledgement flags (what the operator waved through on the day). Every one of those varies
 * between two freezes of a board nobody edited, and hashing them would make each hash unique by
 * construction — which would put `UNIQUE (spec_hash)` permanently out of reach, make
 * `SPEC_ALREADY_FROZEN` impossible to raise, and make two agents built from one contract look as
 * though they were built from different ones.
 *
 * What remains is content: the board and name, the canvas hash and revision the content came from,
 * the process, data, policies, capabilities, outputs, assumptions, known gaps, and acceptance
 * criteria. All of it is still recorded in the stored `spec_json`; it is only kept out of the
 * identity, so provenance stays readable without pretending to be part of the agreement.
 */
export function specSemanticView(specJson: SpecJson): Record<string, unknown> {
  const { specId: _specId, specVersion: _specVersion, ...identity } = specJson.identity;
  const {
    frozenAt: _frozenAt,
    reviewSessionIds: _reviewSessionIds,
    acknowledgedUnresolvedBlockers: _ackBlockers,
    acknowledgedStaleReview: _ackStale,
    ...source
  } = specJson.source;
  return { ...specJson, identity, source };
}

/** The canonical `spec_hash`: SHA-256 over the semantic view, never over the raw compiled object. */
export function deriveSpecHash(specJson: SpecJson): string {
  return sha256Hex(specSemanticView(specJson));
}

/**
 * Compile a validated graph plus structured assumptions and gaps into `spec_json`.
 *
 * Everything here is a pure function of its inputs and every collection is ordered
 * deterministically, so the same board at the same revision always produces the same
 * `spec_hash`. The compiler reads `metadata_json` only: it never inspects comment body text to
 * decide what a comment means, because a prefix convention is not a contract.
 */
export function compileSpec(input: CompileSpecInput): CompileSpecResult {
  const { graph } = input;
  const errors: CompilerError[] = [];

  for (const issue of validateGraphIntegrity(graph)) {
    if (issue.code === 'DUPLICATE_NODE_ID' || issue.code === 'DUPLICATE_EDGE_ID') {
      errors.push({
        code: 'DUPLICATE_ID',
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
        ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
        message: issue.message,
      });
    } else {
      errors.push({
        code: 'MISSING_REFERENCE',
        ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
        message: issue.message,
      });
    }
  }

  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));
  const documentTypes: string[] = [];
  const fieldSchemas: Record<string, SpecJson['data']['fieldSchemas'][string]> = {};
  const correlationKeys: string[] = [];
  const validationRules: SpecJson['policies']['validationRules'] = [];
  const waits: SpecJson['policies']['waits'] = [];
  const retries: SpecJson['policies']['retries'] = [];
  const exceptions: SpecJson['policies']['exceptions'] = [];
  const humanHandoffs: SpecJson['policies']['humanHandoffs'] = [];
  const capabilities: string[] = [];
  const specNodes: SpecNode[] = [];

  for (const node of graph.nodes) {
    specNodes.push({
      nodeId: node.nodeId,
      primitiveType: node.primitiveType,
      title: node.title,
      data: node.data,
    });

    switch (node.primitiveType) {
      // Input becomes workflow input and data.
      case 'input': {
        const parsed = InputDataSchema.safeParse(node.data);
        if (!parsed.success) {
          errors.push(cardError(node.nodeId, node.title, parsed.error.issues[0]?.message));
          break;
        }
        const data = parsed.data;
        documentTypes.push(...(data.inputKind === 'document' ? [node.title] : []));
        fieldSchemas[node.nodeId] = data.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          description: f.description ?? null,
        }));
        correlationKeys.push(...data.correlationKeys);
        if (data.inputKind === 'document') capabilities.push('document.extract');
        break;
      }

      // Action becomes executable work.
      case 'action': {
        const parsed = ActionDataSchema.safeParse(node.data);
        if (!parsed.success) {
          errors.push(cardError(node.nodeId, node.title, parsed.error.issues[0]?.message));
          break;
        }
        const data = parsed.data;
        if (data.actor === 'human') {
          humanHandoffs.push({ nodeId: node.nodeId, operation: data.operation });
          capabilities.push('human.handoff');
        }
        if (looksLikeCapability(data.operation)) {
          if (isKnownCapability(data.operation)) {
            capabilities.push(data.operation);
          } else {
            errors.push({
              code: 'UNKNOWN_CAPABILITY',
              nodeId: node.nodeId,
              message: `Action "${node.title}" declares unknown capability "${data.operation}"; known capabilities are ${KNOWN_CAPABILITIES.join(', ')}.`,
            });
          }
        }
        break;
      }

      // Rule becomes conditional, timer, retry, or escalation logic.
      case 'rule': {
        const parsed = RuleDataSchema.safeParse(node.data);
        if (!parsed.success) {
          errors.push(cardError(node.nodeId, node.title, parsed.error.issues[0]?.message));
          break;
        }
        const data = parsed.data;
        for (const branch of data.branches) {
          if (branch.targetNodeId !== null && !nodeIds.has(branch.targetNodeId)) {
            errors.push({
              code: 'MISSING_REFERENCE',
              nodeId: node.nodeId,
              message: `Rule "${node.title}" branch "${branch.label}" targets unknown node ${branch.targetNodeId}.`,
            });
          }
        }
        if (data.fallbackNodeId !== null && !nodeIds.has(data.fallbackNodeId)) {
          errors.push({
            code: 'MISSING_REFERENCE',
            nodeId: node.nodeId,
            message: `Rule "${node.title}" falls back to unknown node ${data.fallbackNodeId}.`,
          });
        }
        switch (data.ruleKind) {
          case 'decision':
            validationRules.push({
              nodeId: node.nodeId,
              condition: data.condition,
              branches: data.branches.map((b) => b.label),
            });
            break;
          case 'wait':
            waits.push({ nodeId: node.nodeId, timeoutMinutes: data.timeoutMinutes as number });
            break;
          case 'retry':
            retries.push({ nodeId: node.nodeId, maxAttempts: data.maxAttempts as number });
            break;
          case 'exception':
            exceptions.push({ nodeId: node.nodeId, fallbackNodeId: data.fallbackNodeId });
            break;
        }
        break;
      }

      // Outcome becomes a typed decision plus an optional external action.
      case 'outcome': {
        const parsed = OutcomeDataSchema.safeParse(node.data);
        if (!parsed.success) {
          errors.push(cardError(node.nodeId, node.title, parsed.error.issues[0]?.message));
          break;
        }
        const capability = parsed.data.requiredAction?.capability;
        if (capability !== undefined && capability.length > 0) {
          if (isKnownCapability(capability)) {
            capabilities.push(capability);
          } else {
            errors.push({
              code: 'UNKNOWN_CAPABILITY',
              nodeId: node.nodeId,
              message: `Outcome "${node.title}" requires unknown capability "${capability}"; known capabilities are ${KNOWN_CAPABILITIES.join(', ')}.`,
            });
          }
        }
        break;
      }
    }
  }

  const initialNodeIds = deriveInitialNodeIds(graph);
  const terminalNodeIds = deriveTerminalNodeIds(graph);

  if (graph.nodes.length === 0 || initialNodeIds.length === 0) {
    errors.push({
      code: 'NO_INITIAL_PATH',
      message: 'The process has no starting point; nothing can begin a run.',
    });
  }
  if (terminalNodeIds.length === 0) {
    errors.push({
      code: 'NO_TERMINAL_PATH',
      message: 'The process has no terminal Outcome; no run can finish.',
    });
  }

  if (initialNodeIds.length > 0 && terminalNodeIds.length > 0) {
    const reachable = reachableFrom(graph, initialNodeIds);
    const reachableTerminals = terminalNodeIds.filter((id) => reachable.has(id));
    if (reachableTerminals.length === 0) {
      errors.push({
        code: 'NO_TERMINAL_PATH',
        message: 'No terminal Outcome is reachable from any starting point.',
      });
    }
  }

  if (errors.length > 0) return { errors };

  const transitions: SpecTransition[] = graph.edges.map((e) => ({
    edgeId: e.edgeId,
    from: e.sourceNodeId,
    to: e.targetNodeId,
    label: e.label,
    condition: e.condition,
    priority: e.priority,
  }));

  const assumptions: SpecAssumption[] = [...input.assumptions]
    .map((a) => ({ text: a.assumptionText, sourceCommentId: a.sourceRootCommentId }))
    .sort((a, b) => a.sourceCommentId.localeCompare(b.sourceCommentId));

  const knownGaps: SpecKnownGap[] = [...input.knownGaps]
    .map((g) => ({ text: g.text, severity: g.severity, sourceCommentId: g.sourceCommentId }))
    .sort((a, b) => a.sourceCommentId.localeCompare(b.sourceCommentId));

  const specJson: SpecJson = {
    schemaVersion: '1.1',
    identity: {
      specId: input.specId,
      whiteboardId: graph.metadata.whiteboardId,
      specVersion: input.specVersion,
      name: input.name,
    },
    source: {
      revisionNo: graph.metadata.revisionNo,
      canvasHash: input.canvasHash,
      reviewSessionIds: sortedUnique(input.reviewSessionIds),
      frozenAt: input.frozenAt,
      acknowledgedUnresolvedBlockers: input.acknowledgedUnresolvedBlockers,
      acknowledgedStaleReview: input.acknowledgedStaleReview,
    },
    process: { nodes: specNodes, transitions, initialNodeIds, terminalNodeIds },
    data: {
      documentTypes: sortedUnique(documentTypes),
      fieldSchemas,
      correlationKeys: sortedUnique(correlationKeys),
    },
    policies: { validationRules, waits, retries, exceptions, humanHandoffs },
    capabilities: sortedUnique(capabilities) as Capability[],
    outputs: {
      decisionSchema: DECISION_SCHEMA,
      emailResponseSchema: EMAIL_RESPONSE_SCHEMA,
      shipmentSummarySchema: SHIPMENT_SUMMARY_SCHEMA,
    },
    assumptions,
    knownGaps,
    acceptanceCriteria: buildAcceptanceCriteria(graph, terminalNodeIds),
  };

  const validated = SpecJsonSchema.safeParse(specJson);
  if (!validated.success) {
    return {
      errors: validated.error.issues.map((issue) => ({
        code: 'INVALID_CARD_DATA' as const,
        message: `compiled spec failed validation at ${issue.path.map(String).join('.')}: ${issue.message}`,
      })),
    };
  }
  return { specJson: validated.data };
}

function cardError(nodeId: string, title: string, message: string | undefined): CompilerError {
  return {
    code: 'INVALID_CARD_DATA',
    nodeId,
    message: `Card "${title}" has invalid data: ${message ?? 'schema validation failed'}`,
  };
}

/** Every terminal Outcome is an acceptance criterion; sorted so the hash is stable. */
function buildAcceptanceCriteria(graph: CanonicalGraph, terminalNodeIds: string[]): string[] {
  const titles = new Map(graph.nodes.map((n) => [n.nodeId, n] as const));
  return terminalNodeIds
    .map((id) => {
      const node = titles.get(id);
      if (node === undefined) return `Terminal outcome ${id} is reachable and recorded.`;
      const parsed = OutcomeDataSchema.safeParse(node.data);
      const kind = parsed.success ? parsed.data.resultKind : 'unknown';
      return `A run that ends at "${node.title}" records outcome "${kind}" with its supporting evidence.`;
    })
    .sort();
}

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'outcome',
    'businessKey',
    'reason',
    'shipmentSummary',
    'missingInformation',
    'validationFailures',
    'emailResponse',
  ],
  properties: {
    outcome: {
      type: 'string',
      enum: ['ready', 'needs_information', 'manual_review', 'rejected', 'completed'],
    },
    businessKey: { type: ['string', 'null'] },
    reason: { type: 'string' },
    shipmentSummary: { $ref: '#/definitions/shipmentSummary' },
    missingInformation: { type: 'array', items: { type: 'string' } },
    validationFailures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['scope', 'key', 'field', 'message'],
        properties: {
          scope: { type: 'string', enum: ['invoice', 'good', 'batch', 'shipment'] },
          key: { type: 'string' },
          field: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    emailResponse: { oneOf: [{ $ref: '#/definitions/emailResponse' }, { type: 'null' }] },
  },
};

const EMAIL_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['subject', 'body', 'recipient'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    recipient: { type: 'string' },
  },
};

const SHIPMENT_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'containerNumber',
    'mawb',
    'invoiceNumbers',
    'batchNumbers',
    'goodsCount',
    'validGoodsCount',
  ],
  properties: {
    containerNumber: { type: ['string', 'null'] },
    mawb: { type: ['string', 'null'] },
    invoiceNumbers: { type: 'array', items: { type: 'string' } },
    batchNumbers: { type: 'array', items: { type: 'string' } },
    goodsCount: { type: 'integer' },
    validGoodsCount: { type: 'integer' },
  },
};
