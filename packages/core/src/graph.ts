import { sha256Hex } from './hashing.js';
import type { CanonicalGraph } from './schemas/board.js';
import type { WhiteboardEdge } from './schemas/edge.js';
import type { WhiteboardNode } from './schemas/node.js';
import { OutcomeDataSchema } from './schemas/primitives.js';

export interface CanonicalGraphMetadata {
  whiteboardId: string;
  title: string;
  status: CanonicalGraph['metadata']['status'];
  revisionNo: number;
}

export interface GraphIssue {
  code: 'DANGLING_EDGE_SOURCE' | 'DANGLING_EDGE_TARGET' | 'DUPLICATE_NODE_ID' | 'DUPLICATE_EDGE_ID';
  nodeId?: string;
  edgeId?: string;
  message: string;
}

function byId<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Turn rows into the snapshot that both the review path and the freeze path hash.
 *
 * Nodes sort by `nodeId` and edges by `edgeId`, so the row order PostgreSQL happens to return is
 * irrelevant: the same board always produces the same bytes. Array order *inside* a card (a
 * Rule's `branches`, an Input's `fields`) is author-meaningful and is preserved untouched.
 * Viewport is excluded because panning is not a process change.
 */
export function assembleCanonicalGraph(
  metadata: CanonicalGraphMetadata,
  nodes: readonly WhiteboardNode[],
  edges: readonly WhiteboardEdge[],
): CanonicalGraph {
  return {
    metadata: {
      whiteboardId: metadata.whiteboardId,
      title: metadata.title,
      status: metadata.status,
      revisionNo: metadata.revisionNo,
    },
    nodes: byId(nodes, (n) => n.nodeId).map((n) => ({
      nodeId: n.nodeId,
      primitiveType: n.primitiveType,
      title: n.title,
      data: n.data,
      position: { x: n.position.x, y: n.position.y },
      rowVersion: n.rowVersion,
    })),
    edges: byId(edges, (e) => e.edgeId).map((e) => ({
      edgeId: e.edgeId,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      label: e.label,
      condition: e.condition,
      priority: e.priority,
      rowVersion: e.rowVersion,
    })),
  };
}

/**
 * The canvas hash: SHA-256 over the snapshot with `metadata.status` held out.
 *
 * Everything else in the snapshot changes only when `revision_no` changes, which is what makes the
 * hash a usable name for "the board at revision R". Status is the exception — freezing sets the
 * board to `submitted` in the same transaction without touching the revision — so hashing it would
 * mean one revision had two canvas hashes, and consequently that freezing an unchanged board
 * produced a second, differently-hashed spec instead of the `SPEC_ALREADY_FROZEN` it owes the
 * operator. Status stays in the stored snapshot, where it is a useful record of the moment; it is
 * only kept out of the identity.
 *
 * Viewport is absent for the neighbouring reason: panning is not a process change.
 */
export function deriveCanvasHash(graph: CanonicalGraph): string {
  const { status: _status, ...metadata } = graph.metadata;
  return sha256Hex({ ...graph, metadata });
}

export function validateGraphIntegrity(graph: CanonicalGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (nodeIds.has(node.nodeId)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        nodeId: node.nodeId,
        message: `duplicate node id ${node.nodeId}`,
      });
    }
    nodeIds.add(node.nodeId);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.edgeId)) {
      issues.push({
        code: 'DUPLICATE_EDGE_ID',
        edgeId: edge.edgeId,
        message: `duplicate edge id ${edge.edgeId}`,
      });
    }
    edgeIds.add(edge.edgeId);

    if (!nodeIds.has(edge.sourceNodeId)) {
      issues.push({
        code: 'DANGLING_EDGE_SOURCE',
        edgeId: edge.edgeId,
        nodeId: edge.sourceNodeId,
        message: `edge ${edge.edgeId} references unknown source node ${edge.sourceNodeId}`,
      });
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      issues.push({
        code: 'DANGLING_EDGE_TARGET',
        edgeId: edge.edgeId,
        nodeId: edge.targetNodeId,
        message: `edge ${edge.edgeId} references unknown target node ${edge.targetNodeId}`,
      });
    }
  }

  return issues;
}

/** A node with no inbound edge, plus every Input card — Inputs start a process by definition. */
export function deriveInitialNodeIds(graph: CanonicalGraph): string[] {
  const withInbound = new Set(graph.edges.map((e) => e.targetNodeId));
  return graph.nodes
    .filter((n) => n.primitiveType === 'input' || !withInbound.has(n.nodeId))
    .map((n) => n.nodeId)
    .sort();
}

/** Outcome cards whose card data says the process stops there. */
export function deriveTerminalNodeIds(graph: CanonicalGraph): string[] {
  return graph.nodes
    .filter((n) => {
      if (n.primitiveType !== 'outcome') return false;
      const parsed = OutcomeDataSchema.safeParse(n.data);
      return parsed.success && parsed.data.terminal;
    })
    .map((n) => n.nodeId)
    .sort();
}

/** Node IDs reachable from `starts` following edge direction. Cycles are allowed and terminate. */
export function reachableFrom(graph: CanonicalGraph, starts: readonly string[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.sourceNodeId);
    if (list) list.push(edge.targetNodeId);
    else outgoing.set(edge.sourceNodeId, [edge.targetNodeId]);
  }

  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/** Node IDs that can reach any node in `targets` following edge direction. */
export function canReachAny(graph: CanonicalGraph, targets: readonly string[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.targetNodeId);
    if (list) list.push(edge.sourceNodeId);
    else incoming.set(edge.targetNodeId, [edge.sourceNodeId]);
  }

  const seen = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const prev of incoming.get(current) ?? []) {
      if (!seen.has(prev)) stack.push(prev);
    }
  }
  return seen;
}
