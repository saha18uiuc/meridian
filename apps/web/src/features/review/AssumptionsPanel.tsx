'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * What the operator has already decided, shown while they are still deciding.
 *
 * An assumption is the artefact that closes an ambiguity a review round raised: the operator says
 * what a vague requirement means, and that sentence is carried into the frozen spec. It is also the
 * only evidence that resolves a model finding. Recording one and then having nowhere to see it made
 * the revision loop a sequence of isolated answers rather than a growing account of the process.
 *
 * The list is live assumptions only — superseding one replaces it — because the point is to show
 * the current understanding, not the history of how it was reached. The history is in the threads.
 */

export interface LiveAssumption {
  commentId: string;
  assumptionText: string;
  sourceRootCommentId: string;
}

export function AssumptionsPanel({
  whiteboardId,
  refreshToken,
}: {
  whiteboardId: string;
  /** Changes whenever a thread action may have added or superseded an assumption. */
  refreshToken: number;
}) {
  const [assumptions, setAssumptions] = useState<LiveAssumption[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/whiteboards/${whiteboardId}/assumptions`);
    if (!response.ok) return;
    const body = (await response.json()) as { assumptions: LiveAssumption[] };
    setAssumptions(body.assumptions);
    setLoaded(true);
  }, [whiteboardId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <section className="panel stack" data-testid="assumptions-panel">
      <h3 style={{ margin: 0 }}>Decisions you have recorded</h3>
      <p className="muted">
        Each of these settles something a review round asked about. They are carried into the frozen
        specification word for word.
      </p>
      {assumptions.length === 0 ? (
        <p className="muted" data-testid="assumptions-empty">
          {loaded ? 'None yet. Answer a finding with “Record assumption” to add one.' : 'Loading…'}
        </p>
      ) : (
        <ul className="stack" data-testid="assumptions-list">
          {assumptions.map((assumption) => (
            <li key={assumption.commentId} data-testid={`assumption-${assumption.commentId}`}>
              {assumption.assumptionText}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
