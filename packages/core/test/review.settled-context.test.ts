import { describe, expect, it } from 'vitest';
import { deriveSettledContext, settledContextPrompt } from '../src/review.js';
import type { Comment, RootCommentStatus } from '../src/schemas/comment.js';
import { BOARD_ID, uuid } from './helpers/factories.js';

/**
 * What a later review round is told about earlier ones.
 *
 * The resolution policy requires two things of a model finding before it closes: a recorded
 * assumption, and a round that does not raise it again. Those were being asked of a model that
 * could not see the assumption, so whether an answered question stayed answered depended on
 * whether the model repeated itself. These tests fix what travels with the board.
 */

const SESSION_ID = uuid(2);

let clock = 0;

function root(id: number, body: string, status: RootCommentStatus = 'open'): Comment {
  clock += 1;
  const commentId = uuid(id);
  return {
    commentId,
    whiteboardId: BOARD_ID,
    reviewSessionId: SESSION_ID,
    threadId: commentId,
    parentCommentId: null,
    authorType: 'ai',
    authorUserId: null,
    body,
    anchorType: 'node',
    anchorId: uuid(900 + id),
    anchorFieldPath: null,
    status,
    severity: 'blocking',
    issueKey: `mod:${String(id)}`,
    metadataJson: {
      kind: 'review_issue',
      issueKey: `mod:${String(id)}`,
      checkCode: null,
      origin: 'model',
    },
    suggestedPatchJson: null,
    createdAt: new Date(clock * 1000).toISOString(),
    resolvedAt: null,
  };
}

function replyTo(parent: Comment, id: number, body: string, metadataJson: object): Comment {
  clock += 1;
  return {
    ...parent,
    commentId: uuid(id),
    parentCommentId: parent.commentId,
    authorType: 'system',
    body,
    status: null,
    severity: null,
    issueKey: null,
    metadataJson: metadataJson as Comment['metadataJson'],
    createdAt: new Date(clock * 1000).toISOString(),
  };
}

function assumptionOn(parent: Comment, id: number, text: string, supersedes: string | null) {
  return replyTo(parent, id, text, {
    kind: 'assumption',
    assumptionText: text,
    sourceRootCommentId: parent.commentId,
    supersedesCommentId: supersedes,
  });
}

function rejectionOn(parent: Comment, id: number, reason: string) {
  return replyTo(parent, id, `Rejected: ${reason}`, { kind: 'rejection', reason });
}

describe('deriveSettledContext', () => {
  it('carries an assumption together with the finding it answers', () => {
    const finding = root(10, 'The board does not say what happens when the certificate is absent.');
    const context = deriveSettledContext([
      finding,
      assumptionOn(finding, 11, 'Hold the shipment and email the forwarder.', null),
    ]);

    expect(context.assumptions).toEqual([
      {
        finding: 'The board does not say what happens when the certificate is absent.',
        decision: 'Hold the shipment and email the forwarder.',
        anchorType: 'node',
        anchorId: finding.anchorId,
      },
    ]);
    expect(context.rejections).toEqual([]);
  });

  it('prefers the current assumption over the one it superseded', () => {
    // Superseded rows stay on the thread as history. Sending both would present the operator as
    // having decided two different things about one finding.
    const finding = root(20, 'Nothing states the retry limit.');
    const first = assumptionOn(finding, 21, 'Retry twice.', null);
    const second = assumptionOn(finding, 22, 'Retry three times, then escalate.', first.commentId);

    const context = deriveSettledContext([finding, first, second]);

    expect(context.assumptions.map((entry) => entry.decision)).toEqual([
      'Retry three times, then escalate.',
    ]);
  });

  it('carries a rejection with the rationale recorded against it', () => {
    const finding = root(30, 'This action names no system.', 'rejected');
    const context = deriveSettledContext([
      finding,
      rejectionOn(finding, 31, 'The step is performed in person; there is no system to name.'),
    ]);

    expect(context.rejections).toEqual([
      {
        finding: 'This action names no system.',
        decision: 'The step is performed in person; there is no system to name.',
        anchorType: 'node',
        anchorId: finding.anchorId,
      },
    ]);
  });

  it('ignores a rationale whose root the database does not agree is rejected', () => {
    // The status change and its rationale commit together, so a rationale on a live root means the
    // two disagree. Reporting it as settled would silence a finding nobody dismissed.
    const finding = root(40, 'This branch has no condition.');
    const context = deriveSettledContext([finding, rejectionOn(finding, 41, 'Not applicable.')]);

    expect(context.rejections).toEqual([]);
  });

  it('treats a plain reply as no decision at all', () => {
    // A reply moves a thread to `answered` but changes neither the board nor the specification, so
    // it is not something the reviewer may rely on.
    const finding = root(50, 'The escalation path is undefined.');
    const context = deriveSettledContext([
      finding,
      replyTo(finding, 51, 'Good catch, I will look into it.', { kind: 'reply' }),
    ]);

    expect(context).toEqual({ assumptions: [], rejections: [] });
  });

  it('skips an assumption whose root is not among the comments given', () => {
    const orphaned = root(60, 'Unreferenced.');
    const context = deriveSettledContext([assumptionOn(orphaned, 61, 'Decided.', null)]);

    expect(context.assumptions).toEqual([]);
  });

  it('orders decisions by the finding they answer, whatever order the rows arrive in', () => {
    const first = root(70, 'First finding.');
    const second = root(71, 'Second finding.');
    const decisions = [
      assumptionOn(second, 73, 'Second decision.', null),
      assumptionOn(first, 72, 'First decision.', null),
    ];

    const forwards = deriveSettledContext([first, second, ...decisions]);
    const backwards = deriveSettledContext([...decisions].reverse().concat([second, first]));

    expect(forwards.assumptions.map((entry) => entry.decision)).toEqual([
      'First decision.',
      'Second decision.',
    ]);
    expect(backwards).toEqual(forwards);
  });
});

describe('settledContextPrompt', () => {
  it('is nothing at all when nothing has been settled', () => {
    // A first round has no decisions to carry, and must send exactly what it sent before this
    // existed rather than an empty section inviting the model to read something into it.
    expect(settledContextPrompt({ assumptions: [], rejections: [] })).toBeNull();
  });

  it('states both the decision and the finding it settles', () => {
    const finding = root(80, 'No acceptance criteria are stated.');
    const context = deriveSettledContext([
      finding,
      assumptionOn(finding, 81, 'A run is correct when the broker acknowledges the filing.', null),
    ]);

    const prompt = settledContextPrompt(context) as string;
    expect(prompt).toContain('No acceptance criteria are stated.');
    expect(prompt).toContain('A run is correct when the broker acknowledges the filing.');
    expect(prompt).toContain('do not report');
  });
});
