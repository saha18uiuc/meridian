import { loadOpsEnv, optionalEnv } from './env.js';
import { reconcileQueuedExecutions } from './intake/reconcile-queued-executions.js';
import { opsClient } from './lib/supabase.js';
import { closeOpsTemporalClient, opsTemporalClient } from './lib/temporal.js';
import { runAsync } from './lib/proc.js';

/**
 * A single status read of the whole local system.
 *
 * Beyond the four reachability checks, this also surfaces two failure modes that are otherwise
 * silent: a review session that has been `running` for longer than any model call could plausibly
 * take (A20 — the synchronous route died mid-flight and left the board unable to start another
 * round), and executions still `queued` because Temporal accepted the workflow but the follow-up
 * database write did not land (A24). The second is not merely reported; it is repaired, because
 * the repair is idempotent and the alternative is a run that never appears to start.
 */

export interface HealthEntry {
  component: string;
  status: 'ok' | 'not-started' | 'degraded' | 'error';
  detail: string;
}

async function probe(url: string, accept: readonly number[]): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return accept.includes(response.status);
  } catch {
    return false;
  }
}

async function supabaseHealth(apiPort: number): Promise<HealthEntry> {
  const ok = await probe(`http://127.0.0.1:${apiPort}/rest/v1/`, [200, 401]);
  return {
    component: 'supabase',
    status: ok ? 'ok' : 'not-started',
    detail: `http://127.0.0.1:${apiPort}`,
  };
}

async function temporalHealth(address: string, uiUrl: string): Promise<HealthEntry> {
  // A secured Temporal Service rejects the unauthenticated probe, which the CLI reports the same
  // way it reports a server that is not there. Without the key, `pnpm health` would call a healthy
  // Cloud namespace `not-started` — the one answer that sends an operator looking in the wrong
  // place. The dev server has no credential to check, so passing none there stays correct.
  const apiKey = process.env.TEMPORAL_API_KEY?.trim();
  const health = await runAsync('temporal', [
    'operator',
    'cluster',
    'health',
    '--address',
    address,
    ...(apiKey === undefined || apiKey === '' ? [] : ['--api-key', apiKey, '--tls']),
  ]);
  if (health.code !== 0) return { component: 'temporal', status: 'not-started', detail: address };
  const ui = await probe(uiUrl, [200]);
  return {
    component: 'temporal',
    status: ui ? 'ok' : 'degraded',
    detail: ui ? `${address}, ui ${uiUrl}` : `${address}, ui unreachable`,
  };
}

async function webHealth(baseUrl: string): Promise<HealthEntry> {
  const ok = await probe(`${baseUrl}/api/health`, [200]);
  return { component: 'web', status: ok ? 'ok' : 'not-started', detail: `${baseUrl}/api/health` };
}

interface WorkerHealthBody {
  status?: string;
  registeredVersions?: Array<{ key: string; versionNo: number }>;
}

async function workerHealth(
  port: number,
): Promise<{ entry: HealthEntry; body: WorkerHealthBody | null }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return {
        entry: { component: 'worker', status: 'degraded', detail: `HTTP ${response.status}` },
        body: null,
      };
    }
    const body = (await response.json()) as WorkerHealthBody;
    const count = body.registeredVersions?.length ?? 0;
    return {
      entry: { component: 'worker', status: 'ok', detail: `${count} registered agent version(s)` },
      body,
    };
  } catch {
    return {
      entry: {
        component: 'worker',
        status: 'not-started',
        detail: `http://127.0.0.1:${port}/healthz`,
      },
      body: null,
    };
  }
}

/**
 * Compare what the worker has bundled against what the database believes is active.
 *
 * The registry is compiled into the workflow bundle, so activating a version in the database does
 * not make the worker able to run it. That gap is invisible until an execution fails deep inside a
 * workflow, which is far too late to notice a missing restart.
 */
export async function registryConsistency(
  registered: Array<{ key: string; versionNo: number }> | null,
): Promise<HealthEntry> {
  if (registered === null) {
    return { component: 'registry', status: 'not-started', detail: 'worker not reachable' };
  }
  const client = opsClient();
  const { data, error } = await client
    .from('agents')
    .select(
      'deployment_key, active_agent_version_id, agent_versions!agents_active_agent_version_id_fkey(version_no)',
    )
    .not('active_agent_version_id', 'is', null);
  if (error !== null) {
    return { component: 'registry', status: 'error', detail: error.message };
  }

  const bundled = new Set(registered.map((entry) => `${entry.key}@${entry.versionNo}`));
  const missing: string[] = [];
  for (const row of data) {
    // PostgREST types an embedded resource as an array even when the foreign key makes it at most
    // one row, so both shapes are unwrapped rather than asserted away with a cast.
    const embedded = row.agent_versions;
    const version = Array.isArray(embedded) ? embedded[0] : embedded;
    if (version === undefined || version === null) continue;
    const label = `${row.deployment_key}@${version.version_no}`;
    if (!bundled.has(label)) missing.push(label);
  }

  return missing.length === 0
    ? {
        component: 'registry',
        status: 'ok',
        detail: `${bundled.size} bundled, all active versions present`,
      }
    : {
        component: 'registry',
        status: 'degraded',
        detail: `active but not bundled: ${missing.join(', ')} — regenerate the registry and restart the worker`,
      };
}

export async function stuckReviewSessions(timeoutMs: number): Promise<HealthEntry> {
  const cutoff = new Date(Date.now() - timeoutMs * 2).toISOString();
  const client = opsClient();
  const { data, error } = await client
    .from('review_sessions')
    .select('review_session_id, whiteboard_id, created_at')
    .eq('status', 'running')
    .lt('created_at', cutoff);
  if (error !== null) return { component: 'reviews', status: 'error', detail: error.message };
  const rows = data ?? [];
  return rows.length === 0
    ? { component: 'reviews', status: 'ok', detail: 'no session running past its deadline' }
    : {
        component: 'reviews',
        status: 'degraded',
        detail: `${rows.length} session(s) running longer than ${timeoutMs * 2}ms: ${rows
          .map((r) => r.review_session_id)
          .join(', ')}`,
      };
}

export async function healthCheck(): Promise<HealthEntry[]> {
  loadOpsEnv();
  const apiPort = Number.parseInt(optionalEnv('SUPABASE_API_PORT', '54521'), 10);
  const address = optionalEnv('TEMPORAL_ADDRESS', '127.0.0.1:7233');
  const uiUrl = optionalEnv('TEMPORAL_UI_URL', 'http://127.0.0.1:8233');
  const appUrl = optionalEnv('APP_BASE_URL', 'http://localhost:3000');
  const workerPort = Number.parseInt(optionalEnv('WORKER_HEALTH_PORT', '9464'), 10);
  const reviewTimeout = Number.parseInt(optionalEnv('AI_REVIEW_TIMEOUT_MS', '120000'), 10);

  const entries: HealthEntry[] = [];
  const supabase = await supabaseHealth(apiPort);
  entries.push(supabase);
  entries.push(await temporalHealth(address, uiUrl));
  entries.push(await webHealth(appUrl));
  const worker = await workerHealth(workerPort);
  entries.push(worker.entry);

  if (supabase.status !== 'ok') return entries;

  entries.push(await stuckReviewSessions(reviewTimeout));
  entries.push(await registryConsistency(worker.body?.registeredVersions ?? null));

  try {
    const temporal = await opsTemporalClient();
    const reconciled = await reconcileQueuedExecutions({ supabase: opsClient(), temporal });
    entries.push({
      component: 'queued-executions',
      status: 'ok',
      detail:
        reconciled.length === 0
          ? 'nothing to reconcile'
          : `reconciled ${reconciled.length}: ${reconciled.map((r) => `${r.executionId}=${r.action}`).join(', ')}`,
    });
  } catch (error) {
    entries.push({
      component: 'queued-executions',
      status: 'degraded',
      detail: `could not reconcile: ${(error as Error).message}`,
    });
  } finally {
    await closeOpsTemporalClient();
  }

  return entries;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const entries = await healthCheck();
  const width = Math.max(...entries.map((entry) => entry.component.length));
  for (const entry of entries) {
    process.stdout.write(
      `  ${entry.status.padEnd(12)} ${entry.component.padEnd(width)}  ${entry.detail}\n`,
    );
  }
  if (entries.some((entry) => entry.status === 'error')) process.exitCode = 1;
}
