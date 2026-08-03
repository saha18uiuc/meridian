import type { EvalRunStatus, FailureClass } from '@meridian/core/schemas';
import type { AssertionFailure } from './assertions.js';

/**
 * The shape of a suite result and how it is rendered.
 *
 * Rendering is separated from running so the same report can be printed by the CLI, asserted by a
 * test, and stored against an eval run without three slightly different ideas of what "passed"
 * means.
 */

export interface CaseResult {
  caseKey: string;
  description: string;
  status: EvalRunStatus;
  executionId: string | null;
  durationMs: number;
  failures: AssertionFailure[];
  failureClass: FailureClass | null;
  error: string | null;
}

export interface EvalReport {
  evalRunId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  cases: CaseResult[];
}

export function summarize(report: EvalReport): string {
  const lines = [
    `eval run ${report.evalRunId} — ${report.deploymentKey} v${String(report.versionNo).padStart(3, '0')}`,
    `${String(report.passed)} passed, ${String(report.failed)} failed of ${String(report.cases.length)}`,
    '',
  ];

  for (const result of report.cases) {
    const mark = result.status === 'passed' ? 'PASS' : result.status.toUpperCase();
    lines.push(`${mark.padEnd(6)} ${result.caseKey}  ${result.description}`);
    if (result.error !== null) lines.push(`         error: ${result.error}`);
    for (const failure of result.failures) {
      lines.push(
        `         ${failure.assertion}: ${failure.message} (expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)})`,
      );
    }
    if (result.failureClass !== null) lines.push(`         class: ${result.failureClass}`);
  }

  return lines.join('\n');
}

export function isGreen(report: EvalReport): boolean {
  return report.failed === 0 && report.cases.every((result) => result.status === 'passed');
}

/** The first failure the repair loop should act on, in stable case order. */
export function firstActionableFailure(report: EvalReport): CaseResult | null {
  return report.cases.find((result) => result.status !== 'passed') ?? null;
}
