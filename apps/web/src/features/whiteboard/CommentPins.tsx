'use client';

import { isUnresolvedRoot } from '@meridian/core/review';
import type { Comment, CommentThread } from '@meridian/core/schemas';
import { ViewportPortal } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { ThreadItem } from '@/features/review/ThreadItem';
import type { LocalEdge, LocalNode } from '@/features/whiteboard/useGraphStore';

/**
 * Review findings, drawn on the board where the thing they are about is.
 *
 * They used to be a list pinned to the top-right corner of the canvas showing the *title* of the
 * anchored card and never the comment, and clicking one selected the card in the inspector rather
 * than opening the thread. The bodies lived in a separate panel below the canvas. So a reviewer
 * reading a finding had to work out for themselves which shape on the board it referred to, which
 * is the job the anchor already does — `anchor_type` and `anchor_id` have been on every comment
 * since the first migration.
 *
 * `ViewportPortal` renders into React Flow's transformed layer, so a bubble is positioned in graph
 * coordinates and pans and zooms with the card it belongs to for free. The alternative — tracking
 * the viewport and converting to screen space on every frame — reimplements the transform React
 * Flow already applies, and drifts by a pixel whenever the two disagree.
 *
 * Pins never block editing: opening one is a popover, not a modal, and review stays advisory.
 */

/** Where a card's bubble sits, relative to the card's own origin. */
const BUBBLE_OFFSET_X = 232;
const BUBBLE_OFFSET_Y = -10;

export interface AnchoredThread {
  thread: CommentThread;
  x: number;
  y: number;
}

/**
 * Only findings that are still live get drawn.
 *
 * A resolved or rejected root is history, and history belongs in the list below the canvas rather
 * than pinned to a card forever — a board that accumulates a bubble per finding ever raised stops
 * showing which ones still need an answer, which is the only reason to put them on the canvas.
 *
 * `isUnresolvedRoot` is imported rather than rewritten as `status !== 'resolved'`, because that
 * negative form counts a deliberately rejected finding as outstanding.
 */
function toLiveThreads(comments: Comment[]): CommentThread[] {
  const roots = comments.filter((c) => isUnresolvedRoot(c.parentCommentId, c.status));
  return roots.map((root) => ({
    root,
    replies: comments.filter((c) => c.parentCommentId !== null && c.threadId === root.threadId),
  }));
}

export function CommentPins({
  comments,
  nodes,
  edges,
  revisionNo,
  onChanged,
}: {
  comments: Comment[];
  nodes: LocalNode[];
  edges: LocalEdge[];
  revisionNo: number;
  onChanged: () => void | Promise<void>;
}) {
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const { anchored, canvasLevel, orphaned } = useMemo(() => {
    const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
    const byEdgeId = new Map(edges.map((edge) => [edge.edgeId, edge]));
    const threads = toLiveThreads(comments);

    const placed: AnchoredThread[] = [];
    const board: CommentThread[] = [];
    const lost: CommentThread[] = [];
    // Two findings on one card would otherwise draw exactly on top of each other.
    const stackedAt = new Map<string, number>();

    for (const thread of threads) {
      const { anchorType, anchorId } = thread.root;
      if (anchorType === 'canvas' || anchorId === null) {
        board.push(thread);
        continue;
      }

      let origin: { x: number; y: number } | null = null;
      if (anchorType === 'node') {
        const node = byNodeId.get(anchorId);
        if (node !== undefined) origin = node.position;
      } else {
        const edge = byEdgeId.get(anchorId);
        const source = edge === undefined ? undefined : byNodeId.get(edge.sourceNodeId);
        const target = edge === undefined ? undefined : byNodeId.get(edge.targetNodeId);
        if (source !== undefined && target !== undefined) {
          // The midpoint is where the arrow visually is, which is where a reader looks for a
          // comment about it.
          origin = {
            x: (source.position.x + target.position.x) / 2,
            y: (source.position.y + target.position.y) / 2,
          };
        }
      }

      if (origin === null) {
        lost.push(thread);
        continue;
      }
      const depth = stackedAt.get(anchorId) ?? 0;
      stackedAt.set(anchorId, depth + 1);
      placed.push({
        thread,
        x: origin.x + BUBBLE_OFFSET_X,
        y: origin.y + BUBBLE_OFFSET_Y + depth * 30,
      });
    }
    return { anchored: placed, canvasLevel: board, orphaned: lost };
  }, [comments, nodes, edges]);

  // A thread that resolves between rounds must not leave a popover open over nothing.
  useEffect(() => {
    if (openThreadId === null) return;
    const stillHere = comments.some((c) => c.commentId === openThreadId);
    if (!stillHere) setOpenThreadId(null);
  }, [comments, openThreadId]);

  if (anchored.length === 0 && canvasLevel.length === 0 && orphaned.length === 0) return null;

  return (
    <>
      <ViewportPortal>
        {anchored.map(({ thread, x, y }) => (
          <div
            key={thread.root.commentId}
            className="comment-bubble-anchor"
            style={{ transform: `translate(${String(x)}px, ${String(y)}px)` }}
          >
            <CommentBubble
              thread={thread}
              revisionNo={revisionNo}
              open={openThreadId === thread.root.commentId}
              onToggle={() =>
                setOpenThreadId((current) =>
                  current === thread.root.commentId ? null : thread.root.commentId,
                )
              }
              onChanged={onChanged}
            />
          </div>
        ))}
      </ViewportPortal>

      <div className="comment-pins" data-testid="comment-pins">
        {canvasLevel.length === 0 ? null : (
          <div className="board-level-comments" data-testid="board-level-comments">
            <h4>About the board as a whole</h4>
            <ul className="plain-list">
              {canvasLevel.map((thread) => (
                <li key={thread.root.commentId}>
                  <CommentBubble
                    thread={thread}
                    revisionNo={revisionNo}
                    open={openThreadId === thread.root.commentId}
                    onToggle={() =>
                      setOpenThreadId((current) =>
                        current === thread.root.commentId ? null : thread.root.commentId,
                      )
                    }
                    onChanged={onChanged}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
        {orphaned.length === 0 ? null : (
          <div className="orphaned-anchors" data-testid="orphaned-anchors">
            <h4>Anchored to a removed object</h4>
            <ul>
              {orphaned.map(({ root }) => (
                <li key={root.commentId} className="muted">
                  {root.body.slice(0, 80)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

function CommentBubble({
  thread,
  revisionNo,
  open,
  onToggle,
  onChanged,
}: {
  thread: CommentThread;
  revisionNo: number;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { root } = thread;
  const status = root.status ?? 'open';
  const blocking = root.severity === 'blocking';

  return (
    <div className="comment-bubble">
      <button
        type="button"
        className={`pin${blocking ? ' blocking' : ''}${open ? ' open' : ''}`}
        aria-expanded={open}
        data-testid={`comment-pin-${root.commentId}`}
        data-status={status}
        title={root.body}
        onClick={onToggle}
      >
        <span aria-hidden="true">{blocking ? '●' : '○'}</span>
        <span className="pin-preview">{root.body.slice(0, 48)}</span>
      </button>
      {!open ? null : (
        <div className="comment-popover" data-testid={`comment-popover-${root.commentId}`}>
          <ul className="plain-list">
            <ThreadItem thread={thread} revisionNo={revisionNo} onChanged={onChanged} />
          </ul>
        </div>
      )}
    </div>
  );
}
