'use client';

import type {
  BoardMetadata,
  BoardStatus,
  PrimitiveType,
  Viewport,
  WhiteboardDeltaResponse,
  WhiteboardEdge,
  WhiteboardNode,
} from '@meridian/core/schemas';
import { useSyncExternalStore } from 'react';

/**
 * A node or edge that exists locally. `rowVersion` is absent until the server has accepted it,
 * which is exactly the signal `buildDelta` uses to choose insert versus update, and the signal
 * that lets "create then delete before saving" collapse to nothing instead of a phantom delete.
 */
export type LocalNode = Omit<WhiteboardNode, 'rowVersion'> & { rowVersion?: number };
export type LocalEdge = Omit<WhiteboardEdge, 'rowVersion'> & { rowVersion?: number };

export interface GraphState {
  metadata: BoardMetadata;
  nodes: LocalNode[];
  edges: LocalEdge[];
  dirtyNodeIds: Set<string>;
  deletedNodeIds: Set<string>;
  dirtyEdgeIds: Set<string>;
  deletedEdgeIds: Set<string>;
  viewportDirty: boolean;
}

export interface GraphStore {
  getState(): GraphState;
  /**
   * A standalone function, not a method: `useSyncExternalStore` is handed this reference on its
   * own, so it must not depend on being called through the store object.
   */
  subscribe: (this: void, listener: () => void) => () => void;
  addNode(node: LocalNode): void;
  updateNode(nodeId: string, patch: Partial<Pick<LocalNode, 'title' | 'data' | 'position'>>): void;
  removeNode(nodeId: string): void;
  addEdge(edge: LocalEdge): void;
  updateEdge(
    edgeId: string,
    patch: Partial<Pick<LocalEdge, 'label' | 'condition' | 'priority'>>,
  ): void;
  removeEdge(edgeId: string): void;
  setViewport(viewport: Viewport): void;
  setTitle(title: string, revisionNo: number, status: BoardStatus): void;
  isDirty(): boolean;
  /** Merge an accepted save back in: row versions advance, dirty sets clear. */
  applySaved(response: WhiteboardDeltaResponse, sentAt: SentDelta): void;
  /** Replace everything after a conflict refetch, optionally re-marking local edits as dirty. */
  reload(board: {
    metadata: BoardMetadata;
    nodes: WhiteboardNode[];
    edges: WhiteboardEdge[];
  }): void;
}

/** What a save attempt actually sent, so a late response only clears what it covered. */
export interface SentDelta {
  nodeIds: string[];
  nodeDeletes: string[];
  edgeIds: string[];
  edgeDeletes: string[];
  viewportSent: boolean;
}

export function emptyNodeData(primitiveType: PrimitiveType): Record<string, unknown> {
  switch (primitiveType) {
    case 'input':
      return {
        inputKind: 'event',
        sourceSystem: '',
        required: true,
        fields: [],
        correlationKeys: [],
      };
    case 'action':
      return {
        actor: 'agent',
        operation: 'describe_the_operation',
        instructions: '',
        system: '',
        inputs: [],
        outputs: [],
      };
    case 'rule':
      return { ruleKind: 'decision', condition: '', branches: [], fallbackNodeId: null };
    case 'outcome':
      return { resultKind: 'ready', terminal: true };
  }
}

export function createGraphStore(initial: {
  metadata: BoardMetadata;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}): GraphStore {
  let state: GraphState = {
    metadata: initial.metadata,
    nodes: [...initial.nodes],
    edges: [...initial.edges],
    dirtyNodeIds: new Set(),
    deletedNodeIds: new Set(),
    dirtyEdgeIds: new Set(),
    deletedEdgeIds: new Set(),
    viewportDirty: false,
  };

  const listeners = new Set<() => void>();
  function emit(next: GraphState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function withSet(source: Set<string>, add?: string, remove?: string): Set<string> {
    const next = new Set(source);
    if (add !== undefined) next.add(add);
    if (remove !== undefined) next.delete(remove);
    return next;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    addNode(node) {
      emit({
        ...state,
        nodes: [...state.nodes, node],
        dirtyNodeIds: withSet(state.dirtyNodeIds, node.nodeId),
      });
    },

    updateNode(nodeId, patch) {
      const index = state.nodes.findIndex((n) => n.nodeId === nodeId);
      if (index === -1) return;
      const current = state.nodes[index] as LocalNode;
      const next = { ...current, ...patch };
      const nodes = [...state.nodes];
      nodes[index] = next;
      emit({ ...state, nodes, dirtyNodeIds: withSet(state.dirtyNodeIds, nodeId) });
    },

    removeNode(nodeId) {
      const node = state.nodes.find((n) => n.nodeId === nodeId);
      if (node === undefined) return;
      // Removing an edge whose endpoint disappears is the client's job; the RPC would otherwise
      // reject the delta for a dangling endpoint.
      const orphanEdgeIds = state.edges
        .filter((e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId)
        .map((e) => e.edgeId);

      const deletedNodeIds = new Set(state.deletedNodeIds);
      const deletedEdgeIds = new Set(state.deletedEdgeIds);
      const dirtyNodeIds = withSet(state.dirtyNodeIds, undefined, nodeId);
      const dirtyEdgeIds = new Set(state.dirtyEdgeIds);

      // Never persisted ⇒ it simply never existed as far as the server is concerned.
      if (node.rowVersion !== undefined) deletedNodeIds.add(nodeId);
      for (const edgeId of orphanEdgeIds) {
        const edge = state.edges.find((e) => e.edgeId === edgeId);
        dirtyEdgeIds.delete(edgeId);
        if (edge?.rowVersion !== undefined) deletedEdgeIds.add(edgeId);
      }

      emit({
        ...state,
        nodes: state.nodes.filter((n) => n.nodeId !== nodeId),
        edges: state.edges.filter((e) => !orphanEdgeIds.includes(e.edgeId)),
        dirtyNodeIds,
        deletedNodeIds,
        dirtyEdgeIds,
        deletedEdgeIds,
      });
    },

    addEdge(edge) {
      if (state.edges.some((e) => e.edgeId === edge.edgeId)) return;
      emit({
        ...state,
        edges: [...state.edges, edge],
        dirtyEdgeIds: withSet(state.dirtyEdgeIds, edge.edgeId),
      });
    },

    updateEdge(edgeId, patch) {
      const index = state.edges.findIndex((e) => e.edgeId === edgeId);
      if (index === -1) return;
      const edges = [...state.edges];
      edges[index] = { ...(state.edges[index] as LocalEdge), ...patch };
      emit({ ...state, edges, dirtyEdgeIds: withSet(state.dirtyEdgeIds, edgeId) });
    },

    removeEdge(edgeId) {
      const edge = state.edges.find((e) => e.edgeId === edgeId);
      if (edge === undefined) return;
      const deletedEdgeIds = new Set(state.deletedEdgeIds);
      if (edge.rowVersion !== undefined) deletedEdgeIds.add(edgeId);
      emit({
        ...state,
        edges: state.edges.filter((e) => e.edgeId !== edgeId),
        dirtyEdgeIds: withSet(state.dirtyEdgeIds, undefined, edgeId),
        deletedEdgeIds,
      });
    },

    setViewport(viewport) {
      const current = state.metadata.viewport;
      if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
        return;
      }
      emit({ ...state, metadata: { ...state.metadata, viewport }, viewportDirty: true });
    },

    setTitle(title, revisionNo, status) {
      emit({ ...state, metadata: { ...state.metadata, title, revisionNo, status } });
    },

    isDirty() {
      return (
        state.dirtyNodeIds.size > 0 ||
        state.deletedNodeIds.size > 0 ||
        state.dirtyEdgeIds.size > 0 ||
        state.deletedEdgeIds.size > 0 ||
        state.viewportDirty
      );
    },

    applySaved(response, sentAt) {
      const nodes = state.nodes.map((node) => {
        const rowVersion = response.nodeRowVersions[node.nodeId];
        return rowVersion === undefined ? node : { ...node, rowVersion };
      });
      const edges = state.edges.map((edge) => {
        const rowVersion = response.edgeRowVersions[edge.edgeId];
        return rowVersion === undefined ? edge : { ...edge, rowVersion };
      });

      const dirtyNodeIds = new Set(state.dirtyNodeIds);
      for (const id of sentAt.nodeIds) dirtyNodeIds.delete(id);
      const dirtyEdgeIds = new Set(state.dirtyEdgeIds);
      for (const id of sentAt.edgeIds) dirtyEdgeIds.delete(id);
      const deletedNodeIds = new Set(state.deletedNodeIds);
      for (const id of sentAt.nodeDeletes) deletedNodeIds.delete(id);
      const deletedEdgeIds = new Set(state.deletedEdgeIds);
      for (const id of sentAt.edgeDeletes) deletedEdgeIds.delete(id);

      emit({
        ...state,
        metadata: { ...state.metadata, revisionNo: response.revisionNo },
        nodes,
        edges,
        dirtyNodeIds,
        dirtyEdgeIds,
        deletedNodeIds,
        deletedEdgeIds,
        viewportDirty: sentAt.viewportSent ? false : state.viewportDirty,
      });
    },

    reload(board) {
      emit({
        metadata: board.metadata,
        nodes: [...board.nodes],
        edges: [...board.edges],
        dirtyNodeIds: new Set(),
        deletedNodeIds: new Set(),
        dirtyEdgeIds: new Set(),
        deletedEdgeIds: new Set(),
        viewportDirty: false,
      });
    },
  };
}

export function useGraphStore<T>(store: GraphStore, selector: (state: GraphState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
