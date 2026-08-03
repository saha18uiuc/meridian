import { assembleCanonicalGraph } from '../../src/graph.js';
import type { CanonicalGraph } from '../../src/schemas/board.js';
import type { WhiteboardEdge } from '../../src/schemas/edge.js';
import type { WhiteboardNode } from '../../src/schemas/node.js';
import type { PrimitiveType } from '../../src/schemas/primitives.js';

/** Deterministic v4-shaped UUIDs so fixtures hash identically on every machine. */
export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export const BOARD_ID = uuid(1);

/** Position is derived from the id so repeated fixture construction hashes identically. */
export function node(
  id: string,
  primitiveType: PrimitiveType,
  title: string,
  data: Record<string, unknown>,
): WhiteboardNode {
  const ordinal = Number.parseInt(id.slice(-12), 16);
  return {
    nodeId: id,
    primitiveType,
    title,
    data,
    position: { x: ordinal * 10, y: ordinal * 20 },
    rowVersion: 1,
  };
}

export function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  label: string | null = null,
): WhiteboardEdge {
  return {
    edgeId: id,
    sourceNodeId,
    targetNodeId,
    label,
    condition: null,
    priority: 0,
    rowVersion: 1,
  };
}

export function graphOf(
  nodes: readonly WhiteboardNode[],
  edges: readonly WhiteboardEdge[],
  revisionNo = 1,
): CanonicalGraph {
  return assembleCanonicalGraph(
    { whiteboardId: BOARD_ID, title: 'Inbound Import Receiving', status: 'draft', revisionNo },
    nodes,
    edges,
  );
}

export const inputData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  inputKind: 'event',
  sourceSystem: 'mailbox',
  required: true,
  fields: [{ name: 'containerNumber', type: 'string', required: true }],
  correlationKeys: ['containerNumber'],
  ...overrides,
});

export const actionData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  actor: 'agent',
  operation: 'mail.read',
  instructions: 'Read the arrival notice.',
  system: 'gmail',
  inputs: [],
  outputs: ['message'],
  ...overrides,
});

export const ruleData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ruleKind: 'decision',
  condition: 'every good has all five identifiers',
  branches: [
    { label: 'complete', condition: 'true', targetNodeId: null },
    { label: 'incomplete', condition: 'false', targetNodeId: null },
  ],
  fallbackNodeId: null,
  ...overrides,
});

export const outcomeData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  resultKind: 'ready',
  terminal: true,
  ...overrides,
});

/**
 * The canonicalization corpus. Every entry must be expressible in both our canonicalizer and
 * `canonicalize@3.0.0`, so it deliberately contains no `NaN`, `undefined`-in-array, `Date`, or
 * other value one of the two rejects and the other silently mangles.
 */
export const CANONICAL_FIXTURES: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: 'null', value: null },
  { name: 'true', value: true },
  { name: 'false', value: false },
  { name: 'zero', value: 0 },
  { name: 'negative zero', value: -0 },
  { name: 'integer', value: 42 },
  { name: 'negative integer', value: -42 },
  { name: 'fraction', value: 1.5 },
  { name: 'tiny exponent', value: 1e-7 },
  { name: 'large exponent', value: 1e21 },
  { name: 'max safe integer', value: Number.MAX_SAFE_INTEGER },
  { name: 'empty string', value: '' },
  { name: 'ascii string', value: 'hello world' },
  { name: 'control characters', value: '\u0000\u0001\u001f' },
  { name: 'quotes and backslashes', value: 'he said "hi" \\ then left' },
  { name: 'newline and tab', value: 'a\nb\tc\rd' },
  { name: 'unicode', value: 'ünïcödé — ключ — 键' },
  { name: 'astral plane', value: '😀🚢' },
  { name: 'empty array', value: [] },
  { name: 'empty object', value: {} },
  { name: 'flat object', value: { b: 1, a: 2, C: 3, c: 4 } },
  { name: 'nested object', value: { z: { y: { x: [1, 2, { w: null }] } }, a: 'first' } },
  { name: 'array of objects', value: [{ b: 1, a: 2 }, { a: 3 }] },
  { name: 'mixed array', value: [null, true, 0, '', [], {}] },
  {
    name: 'keys needing utf-16 ordering',
    value: { 'a\u0000': 1, ab: 2, 'a\uFFFF': 3, A: 4, '': 5 },
  },
  {
    name: 'graph-like snapshot',
    value: {
      metadata: { whiteboardId: BOARD_ID, title: 'Board', status: 'draft', revisionNo: 3 },
      nodes: [
        { nodeId: uuid(2), primitiveType: 'input', title: 'A', data: { inputKind: 'event' } },
      ],
      edges: [],
    },
  },
];

/** A minimal but valid Input -> Action -> Rule -> Outcome process. */
export function validGraph(): CanonicalGraph {
  const input = node(uuid(10), 'input', 'Arrival notice email', inputData());
  const action = node(uuid(11), 'action', 'Extract invoice data', actionData());
  const rule = node(uuid(12), 'rule', 'All identifiers present?', ruleData());
  const ready = node(uuid(13), 'outcome', 'Ready for entry', outcomeData());
  const missing = node(
    uuid(14),
    'outcome',
    'Needs information',
    outcomeData({ resultKind: 'needs_information' }),
  );

  return graphOf(
    [input, action, rule, ready, missing],
    [
      edge(uuid(20), input.nodeId, action.nodeId),
      edge(uuid(21), action.nodeId, rule.nodeId),
      edge(uuid(22), rule.nodeId, ready.nodeId, 'complete'),
      edge(uuid(23), rule.nodeId, missing.nodeId, 'incomplete'),
    ],
  );
}
