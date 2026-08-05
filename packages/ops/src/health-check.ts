import { workerHealthUrl } from '@meridian/core';
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

/**
 * Both halves, because a stack can serve one and not the other.
 *
 * The gateway caches each upstream's address, and `supabase db reset` gives the auth container a
 * new one. The result is a state this probe used to call `ok`: rows are readable, nobody can sign
 * in, and every container reports healthy. It is `degraded`, and `pnpm dev:infra` repairs it.
 */
export function classifySupabaseHealth(rest: boolean, auth: boolean, base: string): HealthEntry {
  if (!rest) return { component: 'supabase', status: 'not-started', detail: base };
  return auth
    ? { component: 'supabase', status: 'ok', detail: base }
    : {
        component: 'supabase',
        status: 'degraded',
        detail: `${base}; data is served but sign-in is not — run \`pnpm dev:infra\` to refresh the gateway`,
      };
}

async function supabaseHealth(apiPort: number): Promise<HealthEntry> {
  const base = `http://127.0.0.1:${apiPort}`;
  const rest = await probe(`${base}/rest/v1/`, [200, 401]);
  // Not probed when REST is down: the answer adds nothing to "the stack is not up".
  const auth = rest && (await probe(`${base}/auth/v1/health`, [200]));
  return classifySupabaseHealth(rest, auth, base);
}

/**
 * Ask the configured namespace whether it is there, rather than asking the cluster.
 *
 * `temporal operator cluster health` asks a cluster-wide question, and an API key is not a
 * cluster-wide credential: Temporal Cloud answers `Request unauthorized` for a namespace that is
 * serving traffic perfectly well. Because the CLI exits non-zero for an unauthorized call exactly
 * as it does for a server that is not running, `pnpm health` reported a healthy Cloud namespace as
 * `not-started` — the one answer that sends an operator to look in the wrong place. Supplying the
 * key was necessary but not sufficient; the command itself had to stop being cluster-scoped.
 *
 * Describing the namespace is a question both targets answer, and a stricter one than liveness: it
 * proves the credential is accepted *for the namespace this repository is configured against*, not
 * merely that something is listening on the address. The dev server has no credential to check, so
 * passing none there stays correct.
 */
export function temporalProbeArgs(
  address: string,
  namespace: string,
  apiKey: string | undefined,
): string[] {
  const key = apiKey?.trim();
  return [
    'operator',
    'namespace',
    'describe',
    '--address',
    address,
    '--namespace',
    namespace,
    ...(key === undefined || key === '' ? [] : ['--api-key', key, '--tls']),
  ];
}

async function temporalHealth(
  address: string,
  namespace: string,
  uiUrl: string,
): Promise<HealthEntry> {
  const health = await runAsync(
    'temporal',
    temporalProbeArgs(address, namespace, process.env.TEMPORAL_API_KEY),
  );
  if (health.code !== 0) {
    return { component: 'temporal', status: 'not-started', detail: `${address} (${namespace})` };
  }
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
  url: string,
): Promise<{ entry: HealthEntry; body: WorkerHealthBody | null }> {
  try {
    const response = await fetch(url, {
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
        detail: url,
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
      // The hint has to name the real constraint. It named an invented one —
      // `agents_active_agent_version_id_fkey`, the name PostgREST would generate for a simple
      // single-column key — but the release pointer is a composite foreign key on
      // `(active_agent_version_id, agent_id)` called `fk_agents_active_version`, so PostgREST could
      // find no such relationship and this check only ever returned its error branch.
      'deployment_key, active_agent_version_id, agent_versions!fk_agents_active_version(version_no)',
    )
    .not('active_agent_version_id', 'is', null);
  if (error !== null) {
    return { component: 'registry', status: 'error', detail: error.message };
  }

  const bundled = new Set(registered.map((entry) => `${entry.key}@${entry.versionNo}`));
  const missing: string[] = [];
  type EmbeddedVersion = { version_no: number };
  for (const row of data) {
    /**
     * The generated types do not describe the embedded shape of a hint-qualified join, so it
     * arrives as `any` and the query's contract is stated here instead: `select` asked for
     * `version_no` and nothing else. PostgREST also types an embedded resource as an array even
     * when the foreign key makes it at most one row, so both shapes are unwrapped rather than one
     * being asserted away.
     */
    const embedded = row.agent_versions as EmbeddedVersion | EmbeddedVersion[] | null;
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
  const namespace = optionalEnv('TEMPORAL_NAMESPACE', 'default');
  const uiUrl = optionalEnv('TEMPORAL_UI_URL', 'http://127.0.0.1:8233');
  const appUrl = optionalEnv('APP_BASE_URL', 'http://localhost:3000');
  const workerUrl = workerHealthUrl();
  const reviewTimeout = Number.parseInt(optionalEnv('AI_REVIEW_TIMEOUT_MS', '120000'), 10);

  const entries: HealthEntry[] = [];
  const supabase = await supabaseHealth(apiPort);
  entries.push(supabase);
  entries.push(await temporalHealth(address, namespace, uiUrl));
  entries.push(await webHealth(appUrl));
  const worker = await workerHealth(workerUrl);
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
