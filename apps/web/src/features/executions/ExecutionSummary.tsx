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
 * What the agent decided, as opposed to whether the workflow finished.
 *
 * The two are different questions and only one of them was on the page. `status` is Temporal's
 * answer — `passed` means the run completed without throwing — while the outcome is the agent's,
 * and it is the entire point of the run: a shipment held for a duplicate invoice is a successful
 * execution reporting a rejection. Reading it required querying the database, which is not a thing
 * an operator can do.
 *
 * Absent on an execution still running, and on one that failed before deciding anything, so its
 * absence is rendered as nothing rather than as an empty row.
 */
function readOutcome(
  summary: Record<string, unknown> | null,
): { resultKind: string; reason: string | null } | null {
  if (summary === null) return null;
  const kind = summary['resultKind'];
  if (typeof kind !== 'string' || kind === '') return null;
  const reason = summary['reason'];
  return { resultKind: kind, reason: typeof reason === 'string' ? reason : null };
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
  const outcome = readOutcome(execution.outputSummaryJson);

  return (
    <div className="panel stack" data-testid="execution-summary">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{execution.caseKey}</h2>
        <span className={execution.status === 'passed' ? 'badge ok' : 'badge'}>
          {execution.status}
        </span>
      </div>
      <dl className="kv">
        {outcome === null ? null : (
          <>
            {/* First, because it is the answer. Everything below it is provenance for the answer. */}
            <dt>Outcome</dt>
            <dd data-testid="execution-outcome">
              <strong>{outcome.resultKind}</strong>
              {outcome.reason === null ? null : <span className="muted"> — {outcome.reason}</span>}
            </dd>
          </>
        )}
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
