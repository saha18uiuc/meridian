import {
  WhiteboardDeltaRequestSchema,
  type EdgeUpsert,
  type NodeUpsert,
  type WhiteboardDeltaRequest,
} from '@meridian/core/schemas';
import type { GraphState } from '@/features/whiteboard/useGraphStore';
import type { SentDelta } from '@/features/whiteboard/useGraphStore';

export class DeltaBuildError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DeltaBuildError';
  }
}

/**
 * Turn dirty tracking into the exact payload `save_whiteboard_delta` expects, and refuse to
 * produce one the RPC would reject for shape reasons. The client mirrors the server rules; the
 * server still enforces them, because the client is not trusted.
 */
export function buildDelta(state: GraphState): {
  request: WhiteboardDeltaRequest;
  sent: SentDelta;
} {
  const nodeUpserts: NodeUpsert[] = [];
  for (const nodeId of state.dirtyNodeIds) {
    const node = state.nodes.find((n) => n.nodeId === nodeId);
    if (node === undefined) continue;
    const upsert: NodeUpsert = {
      nodeId: node.nodeId,
      primitiveType: node.primitiveType,
      title: node.title,
      data: node.data,
      position: node.position,
      ...(node.rowVersion === undefined ? {} : { rowVersion: node.rowVersion }),
    };
    nodeUpserts.push(upsert);
  }

  const edgeUpserts: EdgeUpsert[] = [];
  for (const edgeId of state.dirtyEdgeIds) {
    const edge = state.edges.find((e) => e.edgeId === edgeId);
    if (edge === undefined) continue;
    const upsert: EdgeUpsert = {
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      label: edge.label,
      condition: edge.condition,
      priority: edge.priority,
      ...(edge.rowVersion === undefined ? {} : { rowVersion: edge.rowVersion }),
    };
    edgeUpserts.push(upsert);
  }

  const nodeDeletes = [...state.deletedNodeIds];
  const edgeDeletes = [...state.deletedEdgeIds];

  const collidingNode = nodeUpserts.find((n) => nodeDeletes.includes(n.nodeId));
  if (collidingNode !== undefined) {
    throw new DeltaBuildError(
      'ID_IN_UPSERT_AND_DELETE',
      `node ${collidingNode.nodeId} is both upserted and deleted`,
    );
  }
  const collidingEdge = edgeUpserts.find((e) => edgeDeletes.includes(e.edgeId));
  if (collidingEdge !== undefined) {
    throw new DeltaBuildError(
      'ID_IN_UPSERT_AND_DELETE',
      `edge ${collidingEdge.edgeId} is both upserted and deleted`,
    );
  }

  const request: WhiteboardDeltaRequest = {
    expectedRevisionNo: state.metadata.revisionNo,
    nodeUpserts,
    nodeDeletes,
    edgeUpserts,
    edgeDeletes,
    ...(state.viewportDirty ? { viewport: state.metadata.viewport } : {}),
  };

  const parsed = WhiteboardDeltaRequestSchema.safeParse(request);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DeltaBuildError('INVALID_DELTA', first?.message ?? 'invalid delta');
  }

  return {
    request: parsed.data,
    sent: {
      nodeIds: nodeUpserts.map((n) => n.nodeId),
      nodeDeletes,
      edgeIds: edgeUpserts.map((e) => e.edgeId),
      edgeDeletes,
      viewportSent: state.viewportDirty,
    },
  };
}

export function isEmptyDelta(request: WhiteboardDeltaRequest): boolean {
  return (
    request.nodeUpserts.length === 0 &&
    request.nodeDeletes.length === 0 &&
    request.edgeUpserts.length === 0 &&
    request.edgeDeletes.length === 0 &&
    request.viewport === undefined
  );
}
