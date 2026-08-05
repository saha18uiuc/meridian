'use client';

import type { Execution } from '@meridian/core/schemas';

/**
 * Eval runs carry an expected summary and a computed diff. A live run has neither, so the panel
 * says so rather than rendering an empty comparison that looks like a pass.
 */
export function EvalDiff({ execution }: { execution: Execution }) {
  if (execution.runType !== 'eval') {
    const summary = execution.outputSummaryJson;
    return (
      <div className="stack" data-testid="eval-diff-na">
        <p className="muted">
          This is a live run; there is no expected outcome to compare against. What the agent
          produced:
        </p>
        {/* Saying only "nothing to compare" was accurate and unhelpful: it withheld the result the
            run exists to produce, on the grounds that no second copy of it existed to diff. */}
        {summary === null || Object.keys(summary).length === 0 ? (
          <p className="muted">Nothing yet — the run has not reported an outcome.</p>
        ) : (
          <pre>{JSON.stringify(summary, null, 2)}</pre>
        )}
      </div>
    );
  }
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 16 }} data-testid="eval-diff">
      <div className="stack" style={{ flex: 1 }}>
        <h4 style={{ margin: 0 }}>Expected</h4>
        <pre>{JSON.stringify(execution.expectedSummaryJson ?? {}, null, 2)}</pre>
      </div>
      <div className="stack" style={{ flex: 1 }}>
        <h4 style={{ margin: 0 }}>Actual</h4>
        <pre>{JSON.stringify(execution.outputSummaryJson ?? {}, null, 2)}</pre>
      </div>
      <div className="stack" style={{ flex: 1 }}>
        <h4 style={{ margin: 0 }}>Diff</h4>
        <pre>{JSON.stringify(execution.diffSummaryJson ?? {}, null, 2)}</pre>
      </div>
    </div>
  );
}
