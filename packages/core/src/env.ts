import { z } from 'zod';

/**
 * Fail-fast configuration (§10).
 *
 * Parse errors list variable **names** only. A configuration error that prints the value it
 * rejected leaks the secret into CI logs, terminal scrollback, and screenshots, which is exactly
 * the situation an env contract is supposed to prevent.
 */

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
  SUPABASE_DB_URL: z.string().min(1),
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
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('meridian-receiving'),
  TEMPORAL_UI_URL: z.url().default('http://127.0.0.1:8233'),
  WORKER_HEALTH_PORT: int(9464),
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

/** Every secret name in one place, shared by the env contract and the pino redaction list. */
export const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'COMPOSIO_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'DEMO_USER_PASSWORD',
  'DEMO_OTHER_PASSWORD',
] as const;
