'use client';

import { ActionDataSchema } from '@meridian/core/schemas';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';

/** Action = Task + System + Human Handoff. The actor is the first thing an operator reads. */
export function ActionCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = ActionDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <article
      className={`card card-action${selected === true ? ' selected' : ''}`}
      aria-label={`Action card ${data.node.title}`}
      data-primitive="action"
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="card-kind">Action</span>
        <span className="card-title">{data.node.title}</span>
      </header>
      {detail === null ? (
        <p className="card-invalid">Invalid action data</p>
      ) : (
        <dl>
          <div>
            <dt>Actor</dt>
            <dd>{detail.actor}</dd>
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
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
