'use client';

import { InputDataSchema } from '@meridian/core/schemas';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';

/** Input = Event + Information. The card shows what arrives and what correlates it. */
export function InputCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = InputDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <article
      className={`card card-input${selected === true ? ' selected' : ''}`}
      aria-label={`Input card ${data.node.title}`}
      data-primitive="input"
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="card-kind">Input</span>
        <span className="card-title">{data.node.title}</span>
      </header>
      {detail === null ? (
        <p className="card-invalid">Invalid input data</p>
      ) : (
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{detail.inputKind}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{detail.sourceSystem === '' ? '—' : detail.sourceSystem}</dd>
          </div>
          <div>
            <dt>Fields</dt>
            <dd>
              {detail.fields.length === 0 ? '—' : detail.fields.map((f) => f.name).join(', ')}
            </dd>
          </div>
          <div>
            <dt>Correlates on</dt>
            <dd>{detail.correlationKeys.length === 0 ? '—' : detail.correlationKeys.join(', ')}</dd>
          </div>
        </dl>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
