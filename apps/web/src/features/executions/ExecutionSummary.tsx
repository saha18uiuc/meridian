'use client';

import type { Execution } from '@meridian/core/schemas';

export interface Lineage {
  agentId: string;
  deploymentKey: string;
  agentVersionId: string;
  versionNo: number;
  specId: string;
  specHash: string | null;
  gitCommitSha: string | null;
}

/**
 * The header answers the question every run has to answer: what exactly ran. That is the pinned
 * triple of agent version, spec hash, and Git commit, not just the agent name.
 */
export function ExecutionSummary({
  execution,
  lineage,
}: {
  execution: Execution;
  lineage: Lineage;
}) {
  return (
    <div className="panel stack" data-testid="execution-summary">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{execution.caseKey}</h2>
        <span className={execution.status === 'passed' ? 'badge ok' : 'badge'}>
          {execution.status}
        </span>
      </div>
      <dl className="kv">
        <dt>Agent</dt>
        <dd>
          {lineage.deploymentKey} v{String(lineage.versionNo).padStart(3, '0')}
        </dd>
        <dt>Spec hash</dt>
        <dd>
          <code>{lineage.specHash ?? '—'}</code>
        </dd>
        <dt>Git commit</dt>
        <dd>
          <code>{lineage.gitCommitSha ?? '—'}</code>
        </dd>
        <dt>Business key</dt>
        <dd>
          <code>{execution.businessKey ?? 'none (manual review)'}</code>
        </dd>
        <dt>Workflow</dt>
        <dd>
          <code>{execution.temporalWorkflowId ?? '—'}</code>{' '}
          <span className="muted">{execution.temporalRunId ?? ''}</span>
        </dd>
        <dt>Idempotency key</dt>
        <dd>
          <code>{execution.idempotencyKey.slice(0, 16)}…</code>
        </dd>
      </dl>
      {execution.errorJson === null ? null : (
        <pre className="banner error">{JSON.stringify(execution.errorJson, null, 2)}</pre>
      )}
    </div>
  );
}
