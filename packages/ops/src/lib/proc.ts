import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

/**
 * Thin, honest wrappers over child processes.
 *
 * Everything here returns the exit status rather than throwing on it, because the operational
 * scripts need to distinguish "the tool said no" from "the tool is not installed", and an
 * exception collapses those two into one.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the executable itself could not be found or started. */
  unavailable: boolean;
}

export function run(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): RunResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    ...options,
  });
  if (result.error !== undefined) {
    return { code: 127, stdout: '', stderr: result.error.message, unavailable: true };
  }
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    unavailable: false,
  };
}

/** Run a command and return its trimmed stdout, or `null` when it failed for any reason. */
export function output(command: string, args: readonly string[] = []): string | null {
  const result = run(command, args);
  if (result.code !== 0) return null;
  const text = result.stdout.trim();
  return text.length === 0 ? null : text;
}

export async function runAsync(
  command: string,
  args: readonly string[] = [],
  /** `stdin`, when given, is written to the child and the pipe is then closed. */
  options: SpawnOptions & { stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const { stdin, ...spawnOptions } = options;
    const child = spawn(command, [...args], {
      ...spawnOptions,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: error.message, unavailable: true });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr, unavailable: false });
    });
  });
}

/** Stream a command's output to this process's stdio and resolve with its exit code. */
export async function runInherit(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit', ...options });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** The full command line of a running process, or `null` if it is gone or unreadable. */
export function commandLineOf(pid: number): string | null {
  return output('ps', ['-p', String(pid), '-o', 'command=']);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The PIDs listening on a TCP port. Empty when nothing is listening or `lsof` is unavailable. */
export function listenersOn(port: number): number[] {
  const result = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `check` until it returns true or the deadline passes.
 *
 * Readiness is polled rather than assumed because every one of these services reports itself
 * started well before it can answer a request.
 */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const interval = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}
