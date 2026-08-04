'use client';

import { RuleDataSchema } from '@meridian/core/schemas';
import { labelFor } from '@meridian/core/vocabulary';
import type { NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';
import { CardFrame } from '@/features/whiteboard/nodes/CardFrame';

/** Rule = Decision + Wait + retry/exception behaviour. Branch order is author-meaningful. */
export function RuleCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = RuleDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <CardFrame primitiveType="rule" title={data.node.title} selected={selected === true}>
      {detail === null ? (
        <p className="card-invalid">Invalid rule data</p>
      ) : (
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{labelFor('ruleKind', detail.ruleKind)}</dd>
          </div>
          <div>
            <dt>Condition</dt>
            <dd>{detail.condition === '' ? '—' : detail.condition}</dd>
          </div>
          <div>
            <dt>Branches</dt>
            <dd>
              {detail.branches.length === 0
                ? '—'
                : detail.branches.map((branch) => branch.label).join(' | ')}
            </dd>
          </div>
          <div>
            <dt>Bounds</dt>
            <dd>
              {detail.ruleKind === 'wait'
                ? `${String(detail.timeoutMinutes ?? '?')} min`
                : detail.ruleKind === 'retry'
                  ? `${String(detail.maxAttempts ?? '?')} attempts`
                  : '—'}
            </dd>
          </div>
        </dl>
      )}
    </CardFrame>
  );
}
