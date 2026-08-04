import type { Comment } from '@meridian/core/schemas';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommentPins } from '@/features/whiteboard/CommentPins';
import type { LocalEdge, LocalNode } from '@/features/whiteboard/useGraphStore';

/**
 * Findings drawn where the thing they are about is.
 *
 * The property under test is that a comment reaches the reader with its *body* and its *anchor*
 * together. The predecessor showed the anchored card's title, never the comment, and clicking it
 * selected the card rather than opening the thread — so a reviewer had to hold the mapping between
 * a panel below the canvas and a shape on it in their own head.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const EDGE_ID = '33333333-3333-4333-8333-333333333333';

const nodes: LocalNode[] = [
  {
    nodeId: NODE_A,
    primitiveType: 'rule',
    title: 'Does every good carry the required fields?',
    data: {},
    position: { x: 100, y: 200 },
    rowVersion: 1,
  },
  {
    nodeId: NODE_B,
    primitiveType: 'outcome',
    title: 'Ready to receive',
    data: {},
    position: { x: 500, y: 400 },
    rowVersion: 1,
  },
];

const edges: LocalEdge[] = [
  {
    edgeId: EDGE_ID,
    sourceNodeId: NODE_A,
    targetNodeId: NODE_B,
    label: 'all fields present',
    condition: null,
    priority: 0,
    rowVersion: 1,
  },
];

let n = 0;
function comment(overrides: Partial<Comment>): Comment {
  n += 1;
  return {
    commentId: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
    threadId: `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`,
    whiteboardId: '44444444-4444-4444-8444-444444444444',
    parentCommentId: null,
    reviewSessionId: null,
    authorType: 'ai',
    body: 'A finding body',
    issueKey: 'det:DISCONNECTED_NODE:node:x:-',
    severity: 'non_blocking',
    status: 'open',
    anchorType: 'node',
    anchorId: NODE_A,
    anchorFieldPath: null,
    suggestedPatchJson: null,
    metadataJson: {},
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Comment;
}

/**
 * `fireEvent.click`, not `userEvent.click`.
 *
 * These bubbles live inside a mounted React Flow, whose pane installs d3-zoom on `mousedown`, and
 * d3 dereferences `event.view.document` — which jsdom leaves null on the pointer sequence
 * `userEvent` synthesises. A plain click reaches the handler under test without going through the
 * pan gesture, which is not part of what these cases are about.
 */
function clickPin(commentId: string): void {
  fireEvent.click(screen.getByTestId(`comment-pin-${commentId}`));
}

function renderPins(comments: Comment[]) {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[]} edges={[]}>
        <CommentPins
          comments={comments}
          nodes={nodes}
          edges={edges}
          revisionNo={3}
          onChanged={() => undefined}
        />
      </ReactFlow>
    </ReactFlowProvider>,
  );
}

describe('comment bubbles on the canvas', () => {
  it('shows the finding itself, not the title of the card it is about', () => {
    const finding = comment({ body: 'The NDC number is never checked against the invoice.' });
    renderPins([finding]);

    const pin = screen.getByTestId(`comment-pin-${finding.commentId}`);
    expect(pin).toHaveTextContent('The NDC number is never checked');
  });

  it('places a node-anchored bubble at that node’s own coordinates', () => {
    // Placement is what makes it a bubble rather than a list. Node position was previously never
    // read at all.
    const finding = comment({});
    const { container } = renderPins([finding]);

    const anchor = container.querySelector('.comment-bubble-anchor');
    expect(anchor?.getAttribute('style')).toContain('translate(332px, 190px)');
  });

  it('places an edge-anchored bubble between the two cards it joins', () => {
    const finding = comment({ anchorType: 'edge', anchorId: EDGE_ID });
    const { container } = renderPins([finding]);

    // Midpoint of (100,200) and (500,400), plus the same offset a card bubble gets.
    const anchor = container.querySelector('.comment-bubble-anchor');
    expect(anchor?.getAttribute('style')).toContain('translate(532px, 290px)');
  });

  it('separates two findings on the same card instead of stacking them exactly', () => {
    const first = comment({});
    const second = comment({});
    const { container } = renderPins([first, second]);

    const styles = [...container.querySelectorAll('.comment-bubble-anchor')].map((element) =>
      element.getAttribute('style'),
    );
    expect(styles[0]).not.toEqual(styles[1]);
  });

  it('opens the thread in place, with the actions the panel below the canvas offers', () => {
    const finding = comment({ body: 'Which invoice wins when two arrive?' });
    renderPins([finding]);

    expect(screen.queryByTestId(`comment-popover-${finding.commentId}`)).not.toBeInTheDocument();
    clickPin(finding.commentId);

    const popover = screen.getByTestId(`comment-popover-${finding.commentId}`);
    expect(popover).toHaveTextContent('Which invoice wins when two arrive?');
    expect(screen.getByTestId(`thread-${finding.commentId}`)).toBeInTheDocument();
  });

  it('closes an open bubble when it is clicked again', () => {
    const finding = comment({});
    renderPins([finding]);

    clickPin(finding.commentId);
    clickPin(finding.commentId);
    expect(screen.queryByTestId(`comment-popover-${finding.commentId}`)).not.toBeInTheDocument();
  });

  it('gives a canvas-anchored finding somewhere to live', () => {
    // A finding about the board as a whole has no coordinates, and dropping it would hide the
    // review's most sweeping observations.
    const finding = comment({
      anchorType: 'canvas',
      anchorId: null,
      body: 'No path reaches a terminal outcome.',
    });
    renderPins([finding]);

    expect(screen.getByTestId('board-level-comments')).toHaveTextContent(
      'No path reaches a terminal outcome.',
    );
  });

  it('keeps reporting a finding whose anchor was deleted', () => {
    const finding = comment({ anchorId: '99999999-9999-4999-8999-999999999999' });
    renderPins([finding]);
    expect(screen.getByTestId('orphaned-anchors')).toBeInTheDocument();
  });

  it('marks a blocking finding as blocking', () => {
    const finding = comment({ severity: 'blocking' });
    renderPins([finding]);
    expect(screen.getByTestId(`comment-pin-${finding.commentId}`).className).toContain('blocking');
  });

  it('still draws a finding that has been answered but not resolved', () => {
    // Answering is a reply, and a reply is not a fix. The board must keep saying so.
    const finding = comment({ status: 'answered' });
    renderPins([finding]);
    expect(screen.getByTestId(`comment-pin-${finding.commentId}`)).toBeInTheDocument();
  });

  it('takes a resolved finding off the board', () => {
    // It stays in the list below the canvas, which is the history. Keeping a bubble for every
    // finding ever raised would drown the ones still waiting on somebody.
    const finding = comment({ status: 'resolved' });
    const { container } = renderPins([finding]);
    expect(container.querySelectorAll('.comment-bubble-anchor')).toHaveLength(0);
  });

  it('takes a rejected finding off the board too', () => {
    const finding = comment({ status: 'rejected' });
    const { container } = renderPins([finding]);
    expect(container.querySelectorAll('.comment-bubble-anchor')).toHaveLength(0);
  });
});
