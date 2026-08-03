'use client';

import { OutcomeDataSchema } from '@meridian/core/schemas';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';

/** Outcome = the meaningful result, and whether anything still has to happen because of it. */
export function OutcomeCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = OutcomeDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <article
      className={`card card-outcome${selected === true ? ' selected' : ''}`}
      aria-label={`Outcome card ${data.node.title}`}
      data-primitive="outcome"
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="card-kind">Outcome</span>
        <span className="card-title">{data.node.title}</span>
      </header>
      {detail === null ? (
        <p className="card-invalid">Invalid outcome data</p>
      ) : (
        <dl>
          <div>
            <dt>Result</dt>
            <dd>{detail.resultKind}</dd>
          </div>
          <div>
            <dt>Terminal</dt>
            <dd>{detail.terminal ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Required action</dt>
            <dd>{detail.requiredAction === undefined ? '—' : detail.requiredAction.actionType}</dd>
          </div>
          <div>
            <dt>Capability</dt>
            <dd>{detail.requiredAction?.capability ?? '—'}</dd>
          </div>
        </dl>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
