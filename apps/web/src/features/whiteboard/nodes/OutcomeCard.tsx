'use client';

import { OutcomeDataSchema } from '@meridian/core/schemas';
import { labelFor } from '@meridian/core/vocabulary';
import type { NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';
import { CardFrame } from '@/features/whiteboard/nodes/CardFrame';

/** Outcome = the meaningful result, and whether anything still has to happen because of it. */
export function OutcomeCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = OutcomeDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <CardFrame primitiveType="outcome" title={data.node.title} selected={selected === true}>
      {detail === null ? (
        <p className="card-invalid">Invalid outcome data</p>
      ) : (
        <dl>
          <div>
            <dt>Result</dt>
            <dd>{labelFor('resultKind', detail.resultKind)}</dd>
          </div>
          <div>
            <dt>Ends here</dt>
            <dd>{detail.terminal ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Must happen</dt>
            <dd>{detail.requiredAction === undefined ? '—' : detail.requiredAction.actionType}</dd>
          </div>
          <div>
            <dt>Capability</dt>
            <dd>{detail.requiredAction?.capability ?? '—'}</dd>
          </div>
        </dl>
      )}
    </CardFrame>
  );
}
