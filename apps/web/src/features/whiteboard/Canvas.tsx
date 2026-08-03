'use client';

import type { Comment, PrimitiveType } from '@meridian/core/schemas';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeChange,
  type OnConnect,
  type Viewport as FlowViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CommentPins } from '@/features/whiteboard/CommentPins';
import { ConflictBanner } from '@/features/whiteboard/ConflictBanner';
import { Inspector } from '@/features/whiteboard/Inspector';
import { toFlowEdge } from '@/features/whiteboard/edgeUtils';
import { ActionCard } from '@/features/whiteboard/nodes/ActionCard';
import { InputCard } from '@/features/whiteboard/nodes/InputCard';
import { OutcomeCard } from '@/features/whiteboard/nodes/OutcomeCard';
import { RuleCard } from '@/features/whiteboard/nodes/RuleCard';
import {
  emptyNodeData,
  useGraphStore,
  type GraphStore,
  type LocalNode,
} from '@/features/whiteboard/useGraphStore';
import { useSaveDelta } from '@/features/whiteboard/useSaveDelta';

export type MeridianNodeData = { node: LocalNode };
export type MeridianFlowNode = Node<MeridianNodeData, PrimitiveType>;

const nodeTypes = {
  input: InputCard,
  action: ActionCard,
  rule: RuleCard,
  outcome: OutcomeCard,
};

const PRIMITIVES: PrimitiveType[] = ['input', 'action', 'rule', 'outcome'];

export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export function Canvas({
  store,
  whiteboardId,
  comments,
}: {
  store: GraphStore;
  whiteboardId: string;
  comments: Comment[];
}) {
  const state = useGraphStore(store, (s) => s);
  const [selection, setSelection] = useState<Selection>(null);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { status, conflict, error, reapply, discard } = useSaveDelta(store, whiteboardId);

  const flowNodes = useMemo<MeridianFlowNode[]>(
    () =>
      state.nodes.map((node) => ({
        id: node.nodeId,
        type: node.primitiveType,
        position: node.position,
        data: { node },
        selected: selection?.kind === 'node' && selection.id === node.nodeId,
      })),
    [state.nodes, selection],
  );

  const flowEdges = useMemo(() => state.edges.map(toFlowEdge), [state.edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<MeridianFlowNode>[]) => {
      for (const change of changes) {
        if (
          change.type === 'position' &&
          change.position !== undefined &&
          change.dragging === false
        ) {
          store.updateNode(change.id, { position: change.position });
        }
        if (change.type === 'select' && change.selected) {
          setSelection({ kind: 'node', id: change.id });
        }
      }
    },
    [store],
  );

  const onConnect = useCallback<OnConnect>(
    (connection) => {
      if (connection.source === null || connection.target === null) return;
      store.addEdge({
        edgeId: crypto.randomUUID(),
        sourceNodeId: connection.source,
        targetNodeId: connection.target,
        label: null,
        condition: null,
        priority: 0,
      });
    },
    [store],
  );

  const onViewportChange = useCallback(
    (viewport: FlowViewport) => {
      if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => {
        viewportTimer.current = null;
        store.setViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
      }, 600);
    },
    [store],
  );

  const addCard = useCallback(
    (primitiveType: PrimitiveType) => {
      const nodeId = crypto.randomUUID();
      const count = state.nodes.length;
      store.addNode({
        nodeId,
        primitiveType,
        title: `New ${primitiveType}`,
        data: emptyNodeData(primitiveType),
        position: { x: 80 + (count % 5) * 260, y: 80 + Math.floor(count / 5) * 200 },
      });
      setSelection({ kind: 'node', id: nodeId });
    },
    [store, state.nodes.length],
  );

  return (
    <div className="canvas-layout">
      <div className="canvas-toolbar">
        {PRIMITIVES.map((primitiveType) => (
          <button
            key={primitiveType}
            type="button"
            onClick={() => addCard(primitiveType)}
            data-testid={`add-${primitiveType}`}
          >
            + {primitiveType}
          </button>
        ))}
        <span className="muted" data-testid="save-status">
          {status === 'saving'
            ? 'Saving…'
            : status === 'pending'
              ? 'Unsaved changes'
              : status === 'saved'
                ? `Saved · revision ${state.metadata.revisionNo}`
                : status === 'error'
                  ? `Save failed: ${error ?? 'unknown'}`
                  : `Revision ${state.metadata.revisionNo}`}
        </span>
      </div>

      {conflict === null ? null : (
        <ConflictBanner
          conflict={conflict}
          onReapply={() => void reapply()}
          onDiscard={() => void discard()}
        />
      )}

      <div className="canvas-body">
        <div className="canvas-flow" data-testid="canvas">
          <ReactFlowProvider>
            <ReactFlow<MeridianFlowNode>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onConnect={onConnect}
              onViewportChange={onViewportChange}
              onEdgeClick={(_event, edge) => setSelection({ kind: 'edge', id: edge.id })}
              onPaneClick={() => setSelection(null)}
              defaultViewport={state.metadata.viewport}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </ReactFlowProvider>
          <CommentPins
            comments={comments}
            nodes={state.nodes}
            edges={state.edges}
            onSelect={setSelection}
          />
        </div>
        <Inspector store={store} selection={selection} onSelect={setSelection} />
      </div>
    </div>
  );
}
