import { describe, expect, it } from 'vitest';
import { compileSpec, type CompileSpecInput, type CompilerErrorCode } from '../src/compiler.js';
import { sha256Hex } from '../src/hashing.js';
import type { CanonicalGraph } from '../src/schemas/board.js';
import {
  actionData,
  edge,
  graphOf,
  inputData,
  node,
  outcomeData,
  ruleData,
  uuid,
  validGraph,
} from './helpers/factories.js';

function input(graph: CanonicalGraph): CompileSpecInput {
  return {
    graph,
    specId: uuid(200),
    specVersion: 1,
    name: 'Inbound Import Receiving',
    canvasHash: sha256Hex(graph),
    reviewSessionIds: [uuid(202), uuid(201), uuid(202)],
    frozenAt: '2026-08-02T00:00:00.000Z',
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: false,
    assumptions: [],
    knownGaps: [],
  };
}

function errorCodes(graph: CanonicalGraph): CompilerErrorCode[] {
  const result = compileSpec(input(graph));
  return 'errors' in result ? result.errors.map((e) => e.code) : [];
}

describe('compileSpec', () => {
  it('compiles a valid board into schemaVersion 1.1', () => {
    const result = compileSpec(input(validGraph()));
    expect('specJson' in result).toBe(true);
    if (!('specJson' in result)) return;
    expect(result.specJson.schemaVersion).toBe('1.1');
    expect(result.specJson.identity.name).toBe('Inbound Import Receiving');
  });

  it('maps each primitive to its spec section', () => {
    const result = compileSpec(input(validGraph()));
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    const spec = result.specJson;
    expect(spec.data.correlationKeys).toEqual(['containerNumber']);
    expect(spec.policies.validationRules).toHaveLength(1);
    expect(spec.process.transitions).toHaveLength(4);
    expect(spec.process.terminalNodeIds.length).toBeGreaterThan(0);
  });

  it('sorts and de-duplicates review session ids before hashing', () => {
    const result = compileSpec(input(validGraph()));
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    expect(result.specJson.source.reviewSessionIds).toEqual([uuid(201), uuid(202)]);
  });

  it('is deterministic: the same board compiles to the same hash', () => {
    const a = compileSpec(input(validGraph()));
    const b = compileSpec(input(validGraph()));
    if (!('specJson' in a) || !('specJson' in b)) throw new Error('expected compiled specs');
    expect(sha256Hex(a.specJson)).toBe(sha256Hex(b.specJson));
  });

  it('derives capabilities from card declarations only, sorted and de-duplicated', () => {
    const doc = node(uuid(210), 'input', 'Invoice PDF', inputData({ inputKind: 'document' }));
    const read = node(uuid(211), 'action', 'Read mailbox', actionData({ operation: 'mail.read' }));
    const handoff = node(
      uuid(212),
      'action',
      'Broker review',
      actionData({ actor: 'human', operation: 'review shipment', system: '' }),
    );
    const done = node(
      uuid(213),
      'outcome',
      'Reply to sender',
      outcomeData({
        requiredAction: { actionType: 'reply', description: '', capability: 'mail.send' },
      }),
    );
    const graph = graphOf(
      [doc, read, handoff, done],
      [
        edge(uuid(220), doc.nodeId, read.nodeId),
        edge(uuid(221), read.nodeId, handoff.nodeId),
        edge(uuid(222), handoff.nodeId, done.nodeId),
      ],
    );
    const result = compileSpec(input(graph));
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    expect(result.specJson.capabilities).toEqual([
      'document.extract',
      'human.handoff',
      'mail.read',
      'mail.send',
    ]);
  });
});

describe('the six compiler error codes', () => {
  it('MISSING_REFERENCE for a dangling edge', () => {
    const a = node(uuid(230), 'action', 'A', actionData());
    expect(errorCodes(graphOf([a], [edge(uuid(231), a.nodeId, uuid(999))]))).toContain(
      'MISSING_REFERENCE',
    );
  });

  it('MISSING_REFERENCE for a rule branch pointing at a missing node', () => {
    const rule = node(
      uuid(232),
      'rule',
      'Branch',
      ruleData({
        branches: [
          { label: 'a', condition: '', targetNodeId: uuid(9999) },
          { label: 'b', condition: '', targetNodeId: null },
        ],
      }),
    );
    expect(errorCodes(graphOf([rule], []))).toContain('MISSING_REFERENCE');
  });

  it('NO_INITIAL_PATH when every node has an inbound edge and no Input exists', () => {
    const a = node(uuid(233), 'action', 'A', actionData());
    const b = node(uuid(234), 'outcome', 'B', outcomeData());
    expect(
      errorCodes(
        graphOf([a, b], [edge(uuid(235), a.nodeId, b.nodeId), edge(uuid(236), b.nodeId, a.nodeId)]),
      ),
    ).toContain('NO_INITIAL_PATH');
  });

  it('NO_TERMINAL_PATH when no Outcome is terminal', () => {
    const start = node(uuid(237), 'input', 'Start', inputData());
    const open = node(uuid(238), 'outcome', 'Open', outcomeData({ terminal: false }));
    expect(
      errorCodes(graphOf([start, open], [edge(uuid(239), start.nodeId, open.nodeId)])),
    ).toContain('NO_TERMINAL_PATH');
  });

  it('DUPLICATE_ID when the same node appears twice', () => {
    const a = node(uuid(240), 'action', 'A', actionData());
    const graph: CanonicalGraph = { ...graphOf([a], []), nodes: [a, a] };
    expect(errorCodes(graph)).toContain('DUPLICATE_ID');
  });

  it('INVALID_CARD_DATA for an unknown inputKind', () => {
    const bad = node(uuid(241), 'input', 'Bad', { inputKind: 'telepathy' });
    expect(errorCodes(graphOf([bad], []))).toContain('INVALID_CARD_DATA');
  });

  it('UNKNOWN_CAPABILITY for a capability the runtime does not provide', () => {
    const outcome = node(
      uuid(242),
      'outcome',
      'Telegraph',
      outcomeData({
        requiredAction: { actionType: 'telegraph', description: '', capability: 'telegraph.send' },
      }),
    );
    expect(errorCodes(graphOf([outcome], []))).toContain('UNKNOWN_CAPABILITY');
  });

  it('returns errors instead of a partial spec', () => {
    const bad = node(uuid(243), 'input', 'Bad', { inputKind: 'telepathy' });
    const result = compileSpec(input(graphOf([bad], [])));
    expect('specJson' in result).toBe(false);
  });
});
