import { describe, expect, it } from 'vitest';
import {
  assembleCanonicalGraph,
  canReachAny,
  deriveInitialNodeIds,
  deriveTerminalNodeIds,
  reachableFrom,
  validateGraphIntegrity,
} from '../src/graph.js';
import { sha256Hex } from '../src/hashing.js';
import {
  BOARD_ID,
  actionData,
  edge,
  graphOf,
  inputData,
  node,
  outcomeData,
  uuid,
  validGraph,
} from './helpers/factories.js';

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe('assembleCanonicalGraph', () => {
  it('produces the same hash for 100 different row orderings', () => {
    const base = validGraph();
    const expected = sha256Hex(base);
    for (let seed = 1; seed <= 100; seed += 1) {
      const shuffled = assembleCanonicalGraph(
        { ...base.metadata },
        shuffle(base.nodes, seed),
        shuffle(base.edges, seed * 7),
      );
      expect(sha256Hex(shuffled)).toBe(expected);
    }
  });

  it('excludes the viewport, because panning is not a process change', () => {
    const graph = validGraph();
    expect(JSON.stringify(graph)).not.toContain('zoom');
  });

  it('keeps board title in the snapshot, because renaming is a process change', () => {
    const a = validGraph();
    const b = assembleCanonicalGraph(
      { ...a.metadata, title: 'Renamed' },
      [...a.nodes],
      [...a.edges],
    );
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});

describe('validateGraphIntegrity', () => {
  it('accepts a cyclic graph, because loops are legitimate process shapes', () => {
    const a = node(uuid(30), 'action', 'A', actionData());
    const b = node(uuid(31), 'action', 'B', actionData());
    const graph = graphOf(
      [a, b],
      [edge(uuid(40), a.nodeId, b.nodeId), edge(uuid(41), b.nodeId, a.nodeId)],
    );
    expect(validateGraphIntegrity(graph)).toEqual([]);
  });

  it('rejects a dangling edge endpoint', () => {
    const a = node(uuid(30), 'action', 'A', actionData());
    const graph = graphOf([a], [edge(uuid(40), a.nodeId, uuid(999))]);
    const issues = validateGraphIntegrity(graph);
    expect(issues.map((i) => i.code)).toContain('DANGLING_EDGE_TARGET');
  });

  it('reports duplicate ids', () => {
    const a = node(uuid(30), 'action', 'A', actionData());
    const graph = {
      metadata: {
        whiteboardId: BOARD_ID,
        title: 'T',
        status: 'draft' as const,
        revisionNo: 1,
      },
      nodes: [a, a],
      edges: [],
    };
    expect(validateGraphIntegrity(graph).map((i) => i.code)).toContain('DUPLICATE_NODE_ID');
  });
});

describe('initial and terminal derivation', () => {
  it('treats every Input card as a starting point even when it has inbound edges', () => {
    const input = node(uuid(50), 'input', 'Follow-up email', inputData());
    const action = node(uuid(51), 'action', 'Loop back', actionData());
    const graph = graphOf(
      [input, action],
      [edge(uuid(60), input.nodeId, action.nodeId), edge(uuid(61), action.nodeId, input.nodeId)],
    );
    expect(deriveInitialNodeIds(graph)).toContain(input.nodeId);
  });

  it('only counts terminal Outcomes as terminals', () => {
    const done = node(uuid(52), 'outcome', 'Done', outcomeData({ terminal: true }));
    const interim = node(uuid(53), 'outcome', 'Interim', outcomeData({ terminal: false }));
    const graph = graphOf([done, interim], []);
    expect(deriveTerminalNodeIds(graph)).toEqual([done.nodeId]);
  });

  it('walks forward and backward without looping forever on a cycle', () => {
    const graph = validGraph();
    const initial = deriveInitialNodeIds(graph);
    const terminal = deriveTerminalNodeIds(graph);
    expect(reachableFrom(graph, initial).size).toBe(graph.nodes.length);
    expect(canReachAny(graph, terminal).size).toBe(graph.nodes.length);
  });
});
