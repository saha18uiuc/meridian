'use client';

import { InputDataSchema } from '@meridian/core/schemas';
import { labelFor } from '@meridian/core/vocabulary';
import type { NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';
import { CardFrame } from '@/features/whiteboard/nodes/CardFrame';

/** Input = Event + Information. The card shows what arrives and what correlates it. */
export function InputCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = InputDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <CardFrame primitiveType="input" title={data.node.title} selected={selected === true}>
      {detail === null ? (
        <p className="card-invalid">Invalid input data</p>
      ) : (
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{labelFor('inputKind', detail.inputKind)}</dd>
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
    </CardFrame>
  );
}
