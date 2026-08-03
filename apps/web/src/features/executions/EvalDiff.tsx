'use client';

import type { Execution } from '@meridian/core/schemas';

/**
 * Eval runs carry an expected summary and a computed diff. A live run has neither, so the panel
 * says so rather than rendering an empty comparison that looks like a pass.
 */
export function EvalDiff({ execution }: { execution: Execution }) {
  if (execution.runType !== 'eval') {
    return (
      <p className="muted" data-testid="eval-diff-na">
        This is a live run; there is no expected outcome to compare against.
      </p>
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
