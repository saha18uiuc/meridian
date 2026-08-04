'use client';

import type { Comment, PrimitiveType } from '@meridian/core/schemas';
import { PRIMITIVE_GUIDE } from '@meridian/core/vocabulary';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
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

/** The MIME type the palette writes and the canvas reads. */
const DRAG_TYPE = 'application/meridian-primitive';

export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export function Canvas({
  store,
  whiteboardId,
  comments,
  onCommentsChanged,
}: {
  store: GraphStore;
  whiteboardId: string;
  comments: Comment[];
  onCommentsChanged: () => void | Promise<void>;
}) {
  return (
    <ReactFlowProvider>
      <CanvasBody
        store={store}
        whiteboardId={whiteboardId}
        comments={comments}
        onCommentsChanged={onCommentsChanged}
      />
    </ReactFlowProvider>
  );
}

/**
 * The provider is one level up because `screenToFlowPosition` is what turns a drop into a position,
 * and `ViewportPortal` is what puts a comment bubble in graph coordinates. Both are hooks, and both
 * need a provider above the component that calls them.
 */
function CanvasBody({
  store,
  whiteboardId,
  comments,
  onCommentsChanged,
}: {
  store: GraphStore;
  whiteboardId: string;
  comments: Comment[];
  onCommentsChanged: () => void | Promise<void>;
}) {
  const state = useGraphStore(store, (s) => s);
  const [selection, setSelection] = useState<Selection>(null);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { status, conflict, error, reapply, discard } = useSaveDelta(store, whiteboardId);
  const { screenToFlowPosition } = useReactFlow();

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

  const placeCard = useCallback(
    (primitiveType: PrimitiveType, position: { x: number; y: number }) => {
      const nodeId = crypto.randomUUID();
      store.addNode({
        nodeId,
        primitiveType,
        title: `New ${PRIMITIVE_GUIDE[primitiveType].label.toLowerCase()}`,
        data: emptyNodeData(primitiveType),
        position,
      });
      setSelection({ kind: 'node', id: nodeId });
    },
    [store],
  );

  // Clicking still works, and still lays cards out on a grid. Dragging is the addition, not the
  // replacement: a button is reachable from a keyboard and a drop target is not.
  const addCard = useCallback(
    (primitiveType: PrimitiveType) => {
      const count = state.nodes.length;
      placeCard(primitiveType, {
        x: 80 + (count % 5) * 260,
        y: 80 + Math.floor(count / 5) * 200,
      });
    },
    [placeCard, state.nodes.length],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const primitiveType = event.dataTransfer.getData(DRAG_TYPE);
      if (!PRIMITIVES.includes(primitiveType as PrimitiveType)) return;
      placeCard(
        primitiveType as PrimitiveType,
        // The drop lands where the pointer is, converted out of screen space so it is right at any
        // zoom and any pan.
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [placeCard, screenToFlowPosition],
  );

  return (
    <div className="canvas-layout">
      <div className="canvas-toolbar">
        <span className="muted">Drag onto the board, or click to add:</span>
        {PRIMITIVES.map((primitiveType) => {
          const guide = PRIMITIVE_GUIDE[primitiveType];
          return (
            <button
              key={primitiveType}
              type="button"
              className="palette-button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, primitiveType);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => addCard(primitiveType)}
              title={guide.sentence}
              data-testid={`add-${primitiveType}`}
            >
              <span className="palette-label">{guide.addLabel}</span>
              <span className="palette-kind">{guide.label}</span>
            </button>
          );
        })}
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
        <div
          className="canvas-flow"
          data-testid="canvas"
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
        >
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
            <CommentPins
              comments={comments}
              nodes={state.nodes}
              edges={state.edges}
              revisionNo={state.metadata.revisionNo}
              onChanged={onCommentsChanged}
            />
          </ReactFlow>
        </div>
        <Inspector store={store} selection={selection} onSelect={setSelection} />
      </div>
    </div>
  );
}
