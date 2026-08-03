import { describe, expect, it } from 'vitest';
import { MERIDIAN_PORTS, checkPorts, classifyPort, formatReports } from '../src/check-ports.js';
import type { ClassifyDeps } from '../src/check-ports.js';

/**
 * Port classification, which exists to answer one question: is the thing on this port ours?
 *
 * The dangerous answer is a false "owned". A developer running two other local Supabase stacks
 * must never have one of them mistaken for this repository's, because the next thing an operator
 * does with an "owned" port is stop it. Every test here is therefore written from the direction of
 * that mistake: a container on the right port with the wrong project name, a process with the
 * right pid and the wrong command line, and a machine with no `lsof` at all.
 */

function deps(overrides: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return {
    listeners: () => [],
    commandLine: () => null,
    dockerNamesFor: () => [],
    temporalPid: null,
    projectId: 'meridian',
    lsofAvailable: true,
    ...overrides,
  };
}

describe('port classification', () => {
  it('reports an unoccupied port as free', () => {
    expect(classifyPort(7233, deps())).toEqual({ port: 7233, state: 'free' });
  });

  it('claims the Temporal port only when the pid and the command line both match', () => {
    const owned = classifyPort(
      7233,
      deps({
        listeners: () => [4242],
        commandLine: () => 'temporal server start-dev --port 7233',
        temporalPid: 4242,
      }),
    );
    expect(owned.state).toBe('owned');

    // Same recorded pid, different process: the operating system reuses pids, and killing a
    // recycled one is the exact collateral damage this check exists to prevent.
    const recycled = classifyPort(
      7233,
      deps({
        listeners: () => [4242],
        commandLine: () => 'node /some/other/server.js',
        temporalPid: 4242,
      }),
    );
    expect(recycled.state).toBe('foreign');
  });

  it('claims a Supabase port only when the container name carries this project id', () => {
    const owned = classifyPort(
      54521,
      deps({
        listeners: () => [77],
        dockerNamesFor: () => ['supabase_kong_meridian'],
        projectId: 'meridian',
      }),
    );
    expect(owned.state).toBe('owned');

    const someoneElse = classifyPort(
      54521,
      deps({
        listeners: () => [77],
        dockerNamesFor: () => ['supabase_kong_other_project'],
        projectId: 'meridian',
      }),
    );
    expect(someoneElse.state).toBe('foreign');
  });

  it('never claims a non-Supabase port through docker names', () => {
    const report = classifyPort(
      3000,
      deps({ listeners: () => [88], dockerNamesFor: () => ['supabase_kong_meridian'] }),
    );
    expect(report.state).toBe('foreign');
  });

  it('refuses to guess when lsof is unavailable', () => {
    const report = classifyPort(54521, deps({ lsofAvailable: false }));
    // Either answer is acceptable here — it depends on whether anything is actually listening —
    // but "owned" never is, because without lsof there is no evidence of ownership.
    expect(report.state).not.toBe('owned');
  });

  it('checks every port the stack uses and summarizes them', () => {
    const reports = checkPorts(deps());
    expect(reports.map((report) => report.port)).toEqual([...MERIDIAN_PORTS]);
    expect(formatReports(reports)).toContain(`${String(MERIDIAN_PORTS.length)} free`);
  });
});
