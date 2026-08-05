import { z } from 'zod';

/**
 * Fail-fast configuration (§10).
 *
 * Parse errors list variable **names** only. A configuration error that prints the value it
 * rejected leaks the secret into CI logs, terminal scrollback, and screenshots, which is exactly
 * the situation an env contract is supposed to prevent.
 */

/**
 * Delete environment variables whose value is the empty string, and report which.
 *
 * Every `.env` loader in this repository refuses to override a variable already present in the
 * environment, on the grounds that an exported value is the operator being deliberate. That is
 * right for a value and wrong for an empty string, which is not a decision anyone makes on
 * purpose — it arrives from a CI matrix that declares a secret it was not given, a shell profile
 * that exports a name before it has a key, or an editor that injects a placeholder.
 *
 * Left in place it is worse than a missing variable, because it silently wins: the file's real key
 * is never read, `OPENAI_API_KEY` reports absent while sitting in `.env` two feet away, and the
 * review path quietly stays on the deterministic mock. Every reader here already treats `''` as
 * absent — `requireEnv`, `optionalEnv`, `credentialPresence`, the gate report — so this only makes
 * the loaders agree with the rest of the codebase.
 */
export function forgetEmptyEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const cleared: string[] = [];
  for (const name of Object.keys(env)) {
    if (env[name] === '') {
      delete env[name];
      cleared.push(name);
    }
  }
  return cleared.sort();
}

export class EnvironmentError extends Error {
  readonly names: string[];

  constructor(scope: string, names: string[]) {
    super(
      `Invalid environment for ${scope}. Fix these variables (values intentionally not shown): ${names.join(', ')}`,
    );
    this.name = 'EnvironmentError';
    this.names = names;
  }
}

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback) as z.ZodType<number, unknown>;

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export const browserEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_BASE_URL: z.url(),
});
export type BrowserEnv = z.infer<typeof browserEnvSchema>;

const supabaseServer = {
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_BASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /**
   * Optional, because no request path opens a direct Postgres connection: the app reaches the
   * database over PostgREST with the keys above. Only the operational scripts need SQL — migrations,
   * type generation, the seed — and each requires it by name at the point of use.
   *
   * Requiring it here made every deployment carry the superuser connection string to satisfy a
   * schema rather than a caller, and a deployment that omitted it failed on the first route to read
   * server configuration, several layers away from anything resembling the cause.
   */
  SUPABASE_DB_URL: z.string().min(1).optional(),
  APP_BASE_URL: z.url(),
};

const aiEnv = {
  OPENAI_API_KEY: z.string().optional(),
  AI_MODE: z.enum(['mock', 'live']).default('mock'),
  AI_REVIEW_MODEL: z.string().min(1).default('gpt-5.5'),
  AI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('high'),
  AI_REVIEW_MODEL_FALLBACK: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v)),
  AI_ALLOW_LOCAL_FALLBACK: bool(false),
  AI_REVIEW_TIMEOUT_MS: int(120_000),
  AI_REVIEW_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
};

const temporalEnv = {
  TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  /**
   * Temporal Cloud API key. Absent means the local dev server, which takes no credential at all.
   * Supplying one implies TLS, because Cloud refuses an unencrypted connection and a bearer token
   * sent in the clear is worse than no token.
   */
  TEMPORAL_API_KEY: z.string().min(1).optional(),
  /**
   * Turns TLS on without an API key, which is what a self-hosted deployment behind TLS needs.
   * An API key turns TLS on by itself, so this covers only the mTLS and self-hosted cases.
   */
  TEMPORAL_TLS: bool(false),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('meridian-receiving'),
  TEMPORAL_UI_URL: z.url().default('http://127.0.0.1:8233'),
  WORKER_HEALTH_PORT: int(9464),
  /**
   * Where something *other than the worker* can reach the worker's health endpoint.
   *
   * Only meaningful once the two are not on the same machine. Locally the port is enough; deployed,
   * the web app and the worker are separate services and a port number describes nothing.
   */
  WORKER_HEALTH_URL: z.url().optional(),
  /**
   * The worker's own public URL, which it requests on a timer to stay awake.
   *
   * Unset means the host does not sleep idle services and none of this is needed, which is the case
   * locally and on anything paid. It is separate from `WORKER_HEALTH_URL` because that one is for
   * the web app's benefit and this one is for the worker's; they usually hold the same address, but
   * setting one should not silently turn on the other's behaviour.
   */
  WORKER_KEEPALIVE_URL: z.url().optional(),
  /** Comfortably inside the shortest idle timeout worth deploying to (Render's is 15 minutes). */
  WORKER_KEEPALIVE_INTERVAL_MS: int(600_000),
  WORKER_MAX_CONCURRENT_ACTIVITIES: int(20),
  WORKER_MAX_CONCURRENT_WORKFLOWS: int(10),
  /** Fan-out width inside a single agent run; bounded so one execution cannot starve the queue. */
  AGENT_MAX_CONCURRENCY: int(4),
};

const toolEnv = {
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: z.string().optional(),
  COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID: z.string().optional(),
  COMPOSIO_USER_ID: z.string().min(1).default('meridian-demo'),
  COMPOSIO_GMAIL_TOOLKIT_VERSION: z.string().min(1).default('latest'),
  GMAIL_LIVE_MODE: bool(false),
  GMAIL_ALLOWED_RECIPIENTS: csv,
  GMAIL_SEARCH_QUERY: z.string().min(1).default('label:INBOX newer_than:7d'),
  GMAIL_MAX_RESULTS: int(25),
  BROWSER_ALLOWED_DOMAINS: csv,
  BROWSER_WRITE_ENABLED: bool(false),
  PLAYWRIGHT_BROWSERS_PATH: z.string().min(1).default('./.playwright-browsers'),
  OCR_ENABLED: bool(false),
  OCR_MIN_TEXT_CHARS: int(200),
  STORAGE_BUCKET_EMAILS: z.string().min(1).default('emails'),
  STORAGE_BUCKET_ATTACHMENTS: z.string().min(1).default('attachments'),
  STORAGE_BUCKET_OCR: z.string().min(1).default('ocr'),
  STORAGE_BUCKET_SCREENSHOTS: z.string().min(1).default('screenshots'),
};

const commonEnv = {
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /**
   * Where an agent escalates to. It is configuration rather than a constant in the generated code
   * because the address differs between the demo, an eval run, and a real deployment, and burning
   * it into a version would make the code path environment-specific.
   */
  OPERATOR_EMAIL: z.email().default('operator@meridian.local'),
  EVAL_REPAIR_MAX_ITERATIONS: int(3),
  EVAL_CONCURRENCY: int(4),
  MERIDIAN_STATE_DIR: z.string().min(1).default('.meridian'),
};

export const serverEnvSchema = z.object({
  ...supabaseServer,
  ...aiEnv,
  ...temporalEnv,
  ...toolEnv,
  ...commonEnv,
  DEMO_USER_EMAIL: z.email().default('demo@meridian.local'),
  DEMO_USER_PASSWORD: z.string().min(1).optional(),
  DEMO_OTHER_EMAIL: z.email().default('other@meridian.local'),
  DEMO_OTHER_PASSWORD: z.string().min(1).optional(),
});
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const workerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ...aiEnv,
  ...temporalEnv,
  ...toolEnv,
  ...commonEnv,
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

function parseOrThrow<T extends z.ZodType>(
  schema: T,
  scope: string,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const names = [
    ...new Set(
      result.error.issues.map((issue) => issue.path.map(String).join('.')).filter((n) => n !== ''),
    ),
  ].sort();
  throw new EnvironmentError(scope, names);
}

export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  return parseOrThrow(serverEnvSchema, 'server', source);
}

export function parseWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  return parseOrThrow(workerEnvSchema, 'worker', source);
}

export function parseBrowserEnv(
  source: Record<string, string | undefined> = process.env,
): BrowserEnv {
  return parseOrThrow(browserEnvSchema, 'browser', source);
}

let cachedServerEnv: ServerEnv | undefined;

/** Parsed once per process; a later call never re-reads `process.env`. */
export function serverEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv();
  return cachedServerEnv;
}

let cachedWorkerEnv: WorkerEnv | undefined;

export function workerEnv(): WorkerEnv {
  cachedWorkerEnv ??= parseWorkerEnv();
  return cachedWorkerEnv;
}

/** Test-only: drop the memoized values so a test can parse a different environment. */
export function resetEnvCacheForTests(): void {
  cachedServerEnv = undefined;
  cachedWorkerEnv = undefined;
}

export interface TemporalTarget {
  /** Spread into `Connection.connect` or `NativeConnection.connect`; both accept these three. */
  connection: { address: string; tls?: true; apiKey?: string };
  namespace: string;
}

/**
 * Where the Temporal Service is, and how to prove we may talk to it.
 *
 * Five call sites open a connection — the worker, the backend client, the ops CLI, the web intake
 * path, and the health probe — and all five need the same answer. Deriving it once is what stops a
 * move to Cloud from landing in four of them and leaving the fifth pointed at localhost, which
 * would not fail loudly: the health probe would keep reporting a healthy local server that no
 * longer runs anything.
 *
 * TLS follows the API key rather than sitting beside it as a second switch. Temporal Cloud refuses
 * an unencrypted connection, so a key without TLS is a configuration that cannot work — and a
 * bearer token sent in the clear is worse than no token. `TEMPORAL_TLS` remains for the case the
 * key does not cover: a self-hosted deployment behind TLS, authenticating by mTLS or not at all.
 */
export function temporalTarget(
  source: Record<string, string | undefined> = process.env,
): TemporalTarget {
  const apiKey = source.TEMPORAL_API_KEY?.trim();
  const authenticated = apiKey !== undefined && apiKey !== '';
  const tls = authenticated || ['true', '1'].includes((source.TEMPORAL_TLS ?? '').trim());
  return {
    connection: {
      address: source.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
      ...(tls ? { tls: true as const } : {}),
      ...(authenticated ? { apiKey } : {}),
    },
    namespace: source.TEMPORAL_NAMESPACE ?? 'default',
  };
}

/**
 * The worker's health endpoint as seen from somewhere else.
 *
 * Derived here rather than composed at each call site for the same reason as `temporalTarget`: the
 * path is the worker's to choose, and a caller that hardcodes it goes stale silently. This one did
 * — the web health route asked for `/health` while the worker has always served `/healthz`, so the
 * probe reported a dead worker for every deployment including the ones where it was running.
 *
 * The default stays loopback because locally the two share a host. Deployed, they do not, and
 * `WORKER_HEALTH_URL` is how the web app is told where the worker actually is.
 */
export function workerHealthUrl(source: Record<string, string | undefined> = process.env): string {
  const configured = source.WORKER_HEALTH_URL?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return `http://127.0.0.1:${source.WORKER_HEALTH_PORT ?? '9464'}/healthz`;
}

/**
 * Whether Temporal is a server this machine runs, rather than one it merely talks to.
 *
 * `pnpm dev:infra` uses this to decide whether to spawn the dev server at all. Once the address
 * points elsewhere, spawning it would bind 7233 locally and then serve nobody — and because the
 * readiness probe checks loopback, that abandoned server would go on reporting a healthy Temporal
 * while every workflow ran somewhere else. An API key settles the question by itself, since the
 * dev server has no credential to check it against.
 */
export function ownsLocalTemporal(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const { connection } = temporalTarget(source);
  if (connection.apiKey !== undefined) return false;
  const host = connection.address.split(':')[0] ?? '';
  return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
}

/** Every secret name in one place, shared by the env contract and the pino redaction list. */
export const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'COMPOSIO_API_KEY',
  'TEMPORAL_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'DEMO_USER_PASSWORD',
  'DEMO_OTHER_PASSWORD',
] as const;
