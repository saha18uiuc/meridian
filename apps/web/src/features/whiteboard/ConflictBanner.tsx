'use client';

import type { ConflictInfo } from '@/features/whiteboard/useSaveDelta';

const EXPLANATIONS: Record<string, string> = {
  STALE_BOARD_REVISION: 'This board changed somewhere else after you loaded it.',
  STALE_NODE_ROW_VERSION: 'A card you edited changed somewhere else after you loaded it.',
  STALE_EDGE_ROW_VERSION: 'A connection you edited changed somewhere else after you loaded it.',
};

/**
 * The single conflict-recovery affordance. Graph saves and renames both raise it, deliberately,
 * so an operator never has to learn two different recovery stories.
 */
export function ConflictBanner({
  conflict,
  onReapply,
  onDiscard,
}: {
  conflict: ConflictInfo;
  onReapply: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="banner error row" role="alert" data-testid="conflict-banner">
      <span>
        {EXPLANATIONS[conflict.code] ?? 'This board changed somewhere else.'} Nothing of yours was
        overwritten.
        {conflict.currentRevisionNo === null
          ? ''
          : ` The server is at revision ${conflict.currentRevisionNo}.`}
      </span>
      <button type="button" className="primary" onClick={onReapply} data-testid="conflict-reapply">
        Reapply my changes
      </button>
      <button type="button" onClick={onDiscard} data-testid="conflict-discard">
        Discard mine
      </button>
    </div>
  );
}
