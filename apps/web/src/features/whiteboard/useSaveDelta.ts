'use client';

import type {
  BoardMetadata,
  WhiteboardDeltaResponse,
  WhiteboardEdge,
  WhiteboardNode,
} from '@meridian/core/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildDelta, isEmptyDelta } from '@/features/whiteboard/buildDelta';
import type { GraphStore } from '@/features/whiteboard/useGraphStore';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'conflict' | 'error';

export interface ConflictInfo {
  code: string;
  currentRevisionNo: number | null;
}

const DEBOUNCE_MS = 800;

interface BoardPayload {
  metadata: BoardMetadata;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}

/**
 * The only client write path. Edits coalesce for 800 ms, one request goes out at a time, and a
 * 409 surfaces a conflict banner rather than retrying the same stale revision forever.
 */
export function useSaveDelta(store: GraphStore, whiteboardId: string) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    const state = store.getState();
    let built;
    try {
      built = buildDelta(state);
    } catch (buildError) {
      setStatus('error');
      setError(buildError instanceof Error ? buildError.message : 'invalid delta');
      return;
    }
    if (isEmptyDelta(built.request)) {
      setStatus('idle');
      return;
    }

    inFlight.current = true;
    setStatus('saving');
    try {
      const response = await fetch(`/api/whiteboards/${whiteboardId}/delta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.request),
      });
      if (response.status === 409) {
        const body = (await response.json()) as ConflictInfo;
        setConflict({ code: body.code, currentRevisionNo: body.currentRevisionNo ?? null });
        setStatus('conflict');
        return;
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
        setStatus('error');
        return;
      }
      const saved = (await response.json()) as WhiteboardDeltaResponse;
      store.applySaved(saved, built.sent);
      setConflict(null);
      setError(null);
      setStatus(store.isDirty() ? 'pending' : 'saved');
    } catch (networkError) {
      setError(networkError instanceof Error ? networkError.message : 'network error');
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, [store, whiteboardId]);

  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setStatus((current) => (current === 'conflict' ? current : 'pending'));
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => {
    return store.subscribe(() => {
      if (store.isDirty()) schedule();
    });
  }, [store, schedule]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  /** Refetch authoritative rows, then re-apply the operator's still-pending edits on top. */
  const reapply = useCallback(async (): Promise<void> => {
    const before = store.getState();
    const pendingNodes = before.nodes.filter((n) => before.dirtyNodeIds.has(n.nodeId));
    const pendingEdges = before.edges.filter((e) => before.dirtyEdgeIds.has(e.edgeId));
    const deletedNodeIds = [...before.deletedNodeIds];
    const deletedEdgeIds = [...before.deletedEdgeIds];

    const response = await fetch(`/api/whiteboards/${whiteboardId}`);
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      setStatus('error');
      return;
    }
    const board = (await response.json()) as BoardPayload;
    store.reload(board);

    for (const node of pendingNodes) {
      const server = board.nodes.find((n) => n.nodeId === node.nodeId);
      if (server === undefined) {
        // Someone deleted it while we were editing; re-create it with our content.
        const { rowVersion: _dropped, ...rest } = node;
        store.addNode(rest);
      } else {
        store.updateNode(node.nodeId, {
          title: node.title,
          data: node.data,
          position: node.position,
        });
      }
    }
    for (const edge of pendingEdges) {
      const server = board.edges.find((e) => e.edgeId === edge.edgeId);
      if (server === undefined) {
        const { rowVersion: _dropped, ...rest } = edge;
        store.addEdge(rest);
      } else {
        store.updateEdge(edge.edgeId, {
          label: edge.label,
          condition: edge.condition,
          priority: edge.priority,
        });
      }
    }
    for (const edgeId of deletedEdgeIds) store.removeEdge(edgeId);
    for (const nodeId of deletedNodeIds) store.removeNode(nodeId);

    setConflict(null);
    setStatus(store.isDirty() ? 'pending' : 'saved');
  }, [store, whiteboardId]);

  const discard = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/whiteboards/${whiteboardId}`);
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      setStatus('error');
      return;
    }
    store.reload((await response.json()) as BoardPayload);
    setConflict(null);
    setStatus('idle');
  }, [store, whiteboardId]);

  return { status, conflict, error, flush, reapply, discard };
}
