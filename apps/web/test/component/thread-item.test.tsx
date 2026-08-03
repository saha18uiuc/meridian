import type { Comment, CommentThread } from '@meridian/core/schemas';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadItem } from '@/features/review/ThreadItem';

/**
 * A review thread.
 *
 * The controls a thread offers are a statement about who is allowed to decide what. An operator may
 * answer, dismiss with a reason, or convert an answer into an explicit assumption — but there is no
 * "resolve" button anywhere, because resolution is something the next review round concludes after
 * looking at the changed graph. A control that let an operator close their own findings would make
 * every unresolved count meaningless.
 */

const ROOT_ID = '11111111-1111-4111-8111-111111111111';

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    commentId: ROOT_ID,
    whiteboardId: '22222222-2222-4222-8222-222222222222',
    reviewSessionId: '33333333-3333-4333-8333-333333333333',
    threadId: ROOT_ID,
    parentCommentId: null,
    authorType: 'ai',
    authorUserId: null,
    body: 'This action has no described behaviour when the downstream system rejects it.',
    status: 'open',
    severity: 'blocking',
    issueKey: 'mod:unspecified_error_handling:node:abc:-',
    anchorType: 'node',
    anchorId: '44444444-4444-4444-8444-444444444444',
    anchorFieldPath: null,
    suggestedPatchJson: null,
    metadataJson: { kind: 'review_issue' },
    createdAt: '2026-02-11T00:00:00.000Z',
    ...overrides,
  } as Comment;
}

function thread(root: Partial<Comment> = {}, replies: Comment[] = []): CommentThread {
  return { root: comment(root), replies };
}

function renderThread(value: CommentThread) {
  return render(<ThreadItem thread={value} revisionNo={4} onChanged={() => undefined} />);
}

describe('an open finding', () => {
  it('shows its severity, status, and stable issue key', () => {
    renderThread(thread());
    expect(screen.getByTestId(`severity-${ROOT_ID}`)).toHaveTextContent('blocking');
    expect(screen.getByTestId(`status-${ROOT_ID}`)).toHaveTextContent('open');
    // The issue key is shown because it is how the same finding is recognized across rounds.
    expect(screen.getByText('mod:unspecified_error_handling:node:abc:-')).toBeInTheDocument();
  });

  it('offers reply, reject, and assumption — and nothing that resolves it', () => {
    renderThread(thread());
    expect(screen.getByTestId(`thread-${ROOT_ID}`)).toHaveAttribute('data-status', 'open');
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /assumption/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resolve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark.*resolved/i })).not.toBeInTheDocument();
  });

  it('offers the patch control only when the finding carries a patch', () => {
    const { unmount } = renderThread(thread());
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    unmount();

    renderThread(thread({ suggestedPatchJson: { op: 'add_node' } }));
    expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
  });
});

describe('an answered finding', () => {
  it('stays actionable, because a reply is not a resolution', () => {
    renderThread(
      thread({ status: 'answered' }, [
        comment({
          commentId: '55555555-5555-4555-8555-555555555555',
          parentCommentId: ROOT_ID,
          authorType: 'user',
          body: 'The forwarder always includes this on the invoice.',
          status: null,
          severity: null,
          issueKey: null,
        }),
      ]),
    );

    expect(screen.getByTestId(`status-${ROOT_ID}`)).toHaveTextContent('answered');
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByText(/forwarder always includes this/)).toBeInTheDocument();
  });

  it('attributes each reply to who wrote it', () => {
    renderThread(
      thread({ status: 'answered' }, [
        comment({
          commentId: '66666666-6666-4666-8666-666666666666',
          parentCommentId: ROOT_ID,
          authorType: 'system',
          body: 'Raised again in round 2.',
          status: null,
          severity: null,
          issueKey: null,
        }),
      ]),
    );
    // Distinguishing a recurrence the system logged from a sentence a person typed is the whole
    // value of the history.
    expect(screen.getByText('system')).toBeInTheDocument();
  });
});

describe('a closed finding', () => {
  it('explains that a rejection is a decision, not a gate', () => {
    renderThread(thread({ status: 'rejected' }));
    expect(screen.getByText(/dismissed by the operator/i)).toBeInTheDocument();
    expect(screen.getByText(/never gates a freeze/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('credits a resolution to the review round that concluded it', () => {
    renderThread(thread({ status: 'resolved' }));
    expect(screen.getByText(/resolved by a later review round/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assumption/i })).not.toBeInTheDocument();
  });
});

describe('a finding with no severity recorded', () => {
  it('reads as non-blocking rather than as blank', () => {
    renderThread(thread({ severity: null }));
    expect(screen.getByTestId(`severity-${ROOT_ID}`)).toHaveTextContent('non_blocking');
  });
});
