import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PID_PATH,
  STATE_PATH,
  clearState,
  readPidCookie,
  readState,
  repoPath,
  writePidCookie,
  writeState,
} from '../src/lib/state.js';

/**
 * The `.meridian/` state directory, which is the only thing connecting `pnpm dev:infra` to a later
 * `pnpm stop`.
 *
 * Both readers are deliberately total: a missing file, a truncated file, and a file containing
 * something else entirely all mean the same thing — "we own nothing" — and the correct response to
 * all three is to stop rather than to throw. A crash here would leave an operator unable to run
 * `pnpm stop` precisely when the state file is the thing that got corrupted.
 */

const originalState = (() => {
  try {
    return readFileSync(STATE_PATH, 'utf8');
  } catch {
    return null;
  }
})();
const originalPid = (() => {
  try {
    return readFileSync(PID_PATH, 'utf8');
  } catch {
    return null;
  }
})();

beforeEach(() => {
  clearState();
});

afterEach(() => {
  clearState();
  if (originalState !== null) writeFileSync(STATE_PATH, originalState, 'utf8');
  if (originalPid !== null) writeFileSync(PID_PATH, originalPid, 'utf8');
});

describe('dev-infra state', () => {
  it('reads an absent state file as owning nothing', () => {
    rmSync(STATE_PATH, { force: true });
    expect(readState()).toEqual({});
  });

  it('round-trips what dev-infra records', () => {
    writeState({
      temporal: {
        pid: 4242,
        port: 7233,
        uiPort: 8233,
        startedAt: '2026-02-11T00:00:00.000Z',
        logPath: '.meridian/temporal.log',
        cookie: 'cookie-1',
      },
      supabase: { managedBy: 'docker', apiPort: 54521 },
    });
    const state = readState();
    expect(state.temporal?.pid).toBe(4242);
    expect(state.supabase?.apiPort).toBe(54521);
  });

  it('treats a structurally wrong state file as owning nothing', () => {
    writeFileSync(STATE_PATH, JSON.stringify({ temporal: { pid: 'not a number' } }), 'utf8');
    expect(readState()).toEqual({});
  });

  it('rejects a pid without a cookie, because a bare pid is not evidence of ownership', () => {
    writePidCookie(4242, 'cookie-1');
    expect(readPidCookie()).toEqual({ pid: 4242, cookie: 'cookie-1' });

    writeFileSync(PID_PATH, '4242\n', 'utf8');
    // The operating system reuses pids. Without the cookie there is nothing distinguishing our
    // Temporal server from whatever inherited its number, so the answer has to be "unknown".
    expect(readPidCookie()).toBeNull();

    writeFileSync(PID_PATH, 'not-a-pid cookie-1\n', 'utf8');
    expect(readPidCookie()).toBeNull();
  });

  it('clears both files together', () => {
    writeState({ supabase: { managedBy: 'docker', apiPort: 54521 } });
    writePidCookie(1234, 'cookie-2');
    clearState();
    expect(readState()).toEqual({});
    expect(readPidCookie()).toBeNull();
  });

  it('resolves repository paths from the package, not the working directory', () => {
    expect(repoPath('package.json').endsWith('/package.json')).toBe(true);
    expect(readFileSync(repoPath('package.json'), 'utf8')).toContain('"name": "meridian"');
  });
});
