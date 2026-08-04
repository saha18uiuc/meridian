'use client';

import { ActionDataSchema } from '@meridian/core/schemas';
import { labelFor } from '@meridian/core/vocabulary';
import type { NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';
import { CardFrame } from '@/features/whiteboard/nodes/CardFrame';

/** Action = Task + System + Human Handoff. The actor is the first thing an operator reads. */
export function ActionCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = ActionDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <CardFrame primitiveType="action" title={data.node.title} selected={selected === true}>
      {detail === null ? (
        <p className="card-invalid">Invalid action data</p>
      ) : (
        <dl>
          <div>
            <dt>Done by</dt>
            <dd>{labelFor('actor', detail.actor)}</dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{detail.operation}</dd>
          </div>
          <div>
            <dt>System</dt>
            <dd>{detail.system === '' ? '—' : detail.system}</dd>
          </div>
          <div>
            <dt>In / Out</dt>
            <dd>
              {detail.inputs.length === 0 ? '—' : detail.inputs.join(', ')} →{' '}
              {detail.outputs.length === 0 ? '—' : detail.outputs.join(', ')}
            </dd>
          </div>
        </dl>
      )}
    </CardFrame>
  );
}
