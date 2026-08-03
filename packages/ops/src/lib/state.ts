import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The `.meridian/` state directory.
 *
 * `dev-infra` spawns Temporal detached and then exits, so the only thing connecting a later
 * `pnpm stop` to that process is what was written here. The ownership cookie is the important
 * part: a PID on its own is reused by the operating system, and killing a recycled PID is exactly
 * the kind of collateral damage a developer running two other local stacks cannot afford.
 */

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MERIDIAN_DIR = join(REPO_ROOT, '.meridian');
export const STATE_PATH = join(MERIDIAN_DIR, 'dev-infra.json');
export const PID_PATH = join(MERIDIAN_DIR, 'temporal.pid');
export const TEMPORAL_LOG_PATH = join(MERIDIAN_DIR, 'temporal.log');
export const RESOLVED_VERSIONS_PATH = join(MERIDIAN_DIR, 'resolved-versions.json');

export const TemporalStateSchema = z
  .object({
    pid: z.number().int().positive(),
    port: z.number().int().positive(),
    uiPort: z.number().int().positive(),
    startedAt: z.string(),
    logPath: z.string(),
    cookie: z.string(),
  })
  .strict();
export type TemporalState = z.infer<typeof TemporalStateSchema>;

export const SupabaseStateSchema = z
  .object({ managedBy: z.literal('docker'), apiPort: z.number().int().positive() })
  .strict();

export const DevInfraStateSchema = z
  .object({
    temporal: TemporalStateSchema.optional(),
    supabase: SupabaseStateSchema.optional(),
  })
  .strict();
export type DevInfraState = z.infer<typeof DevInfraStateSchema>;

export function ensureStateDir(): void {
  mkdirSync(MERIDIAN_DIR, { recursive: true });
}

/** Read the state file, tolerating absence and corruption alike: both mean "we own nothing". */
export function readState(): DevInfraState {
  let raw: string;
  try {
    raw = readFileSync(STATE_PATH, 'utf8');
  } catch {
    return {};
  }
  const parsed = DevInfraStateSchema.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : {};
}

export function writeState(state: DevInfraState): void {
  ensureStateDir();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function clearState(): void {
  rmSync(STATE_PATH, { force: true });
  rmSync(PID_PATH, { force: true });
}

export function writePidCookie(pid: number, cookie: string): void {
  ensureStateDir();
  writeFileSync(PID_PATH, `${pid} ${cookie}\n`, 'utf8');
}

export function readPidCookie(): { pid: number; cookie: string } | null {
  let raw: string;
  try {
    raw = readFileSync(PID_PATH, 'utf8');
  } catch {
    return null;
  }
  const [pidText, cookie] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidText ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || cookie === undefined || cookie.length === 0)
    return null;
  return { pid, cookie };
}

export interface ResolvedVersions {
  composioGmailToolkit: string;
  resolvedFrom: string;
  resolvedAt: string;
  composioCoreVersion: string;
}

export function writeResolvedVersions(versions: ResolvedVersions): void {
  ensureStateDir();
  writeFileSync(RESOLVED_VERSIONS_PATH, `${JSON.stringify(versions, null, 2)}\n`, 'utf8');
}

export function readResolvedVersions(): ResolvedVersions | null {
  try {
    return JSON.parse(readFileSync(RESOLVED_VERSIONS_PATH, 'utf8')) as ResolvedVersions;
  } catch {
    return null;
  }
}

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
