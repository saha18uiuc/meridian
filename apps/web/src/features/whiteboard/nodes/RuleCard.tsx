'use client';

import { RuleDataSchema } from '@meridian/core/schemas';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';

/** Rule = Decision + Wait + retry/exception behaviour. Branch order is author-meaningful. */
export function RuleCard({ data, selected }: NodeProps<MeridianFlowNode>) {
  const parsed = RuleDataSchema.safeParse(data.node.data);
  const detail = parsed.success ? parsed.data : null;
  return (
    <article
      className={`card card-rule${selected === true ? ' selected' : ''}`}
      aria-label={`Rule card ${data.node.title}`}
      data-primitive="rule"
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="card-kind">Rule</span>
        <span className="card-title">{data.node.title}</span>
      </header>
      {detail === null ? (
        <p className="card-invalid">Invalid rule data</p>
      ) : (
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{detail.ruleKind}</dd>
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
                ? `${detail.timeoutMinutes ?? '?'} min`
                : detail.ruleKind === 'retry'
                  ? `${detail.maxAttempts ?? '?'} attempts`
                  : '—'}
            </dd>
          </div>
        </dl>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
