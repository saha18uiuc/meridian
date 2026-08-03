import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CASE_DIR, loadEvalCases, parseEvalCase } from '../src/case-schema.js';
import { createCaseMailbox, readCaseMessages } from '../src/fixture-mailbox.js';
import { firstActionableFailure, isGreen, summarize, type EvalReport } from '../src/report.js';

/**
 * The parts of the suite runner that can be asserted without a database.
 *
 * `runCase` itself writes real `executions` rows through the real RPCs, so it belongs to
 * `pnpm evals` rather than to a unit test — mocking the recorder here would leave the harness's
 * only interesting claim, that it records what actually happened, unverified. What is checked here
 * is everything upstream of that: the cases load, each case sees only its own fixtures, and the
 * report's notion of "green" is the strict one.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const caseDir = join(repoRoot, DEFAULT_CASE_DIR);

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    evalRunId: '11111111-1111-4111-8111-111111111111',
    agentVersionId: '22222222-2222-4222-8222-222222222222',
    deploymentKey: 'inbound-import-receiving',
    versionNo: 1,
    startedAt: '2026-02-11T00:00:00.000Z',
    finishedAt: '2026-02-11T00:01:00.000Z',
    passed: 0,
    failed: 0,
    cases: [],
    ...overrides,
  };
}

function caseResult(caseKey: string, status: EvalReport['cases'][number]['status']) {
  return {
    caseKey,
    description: caseKey,
    status,
    executionId: null,
    durationMs: 1,
    failures: [],
    failureClass: null,
    error: null,
  };
}

describe('eval case loading', () => {
  it('loads every checked-in case', () => {
    const cases = loadEvalCases(caseDir);
    expect(cases.length).toBe(readdirSync(caseDir).filter((name) => name.endsWith('.json')).length);
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it('requires every case to trace its expectation to the spec', () => {
    for (const evalCase of loadEvalCases(caseDir)) {
      // A case whose expectation cites nothing is policy the harness invented, and a green suite
      // over invented policy is the most expensive kind of false confidence.
      expect(evalCase.specTrace.length).toBeGreaterThan(0);
      expect(evalCase.inputRefs.emailPaths.length).toBeGreaterThan(0);
    }
  });

  it('points at the right fixture when a case key and its filename disagree', () => {
    const first = readdirSync(caseDir).filter((name) => name.endsWith('.json'))[0];
    expect(first).toBeDefined();
    const raw = JSON.parse(readFileSync(join(caseDir, first as string), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(() => parseEvalCase({ ...raw, expected: undefined }, 'test')).toThrow(/expected/);
  });

  it('names every fixture a case declares, and every one of them exists', () => {
    for (const evalCase of loadEvalCases(caseDir)) {
      for (const path of evalCase.inputRefs.emailPaths) {
        expect(() => readFileSync(join(repoRoot, path), 'utf8')).not.toThrow();
      }
      expect(() =>
        readFileSync(join(repoRoot, evalCase.inputRefs.expectedPath), 'utf8'),
      ).not.toThrow();
    }
  });
});

describe('per-case fixture isolation', () => {
  it('shows a case only the messages it declares', async () => {
    const cases = loadEvalCases(caseDir);
    const withOne = cases.find((entry) => entry.inputRefs.emailPaths.length === 1);
    expect(withOne).toBeDefined();

    const { mailbox, messages } = createCaseMailbox(repoRoot, withOne!.inputRefs.emailPaths);
    expect(messages).toHaveLength(1);

    // The shared mock reads a directory of thirteen fixtures. A case that could see the others
    // would pass or fail for reasons its author never wrote down, so an unfiltered search has to
    // come back with this case's message and nothing else.
    const visible = await mailbox.searchMessages('', 100);
    expect(visible.map((message) => message.messageId)).toEqual([messages[0]!.messageId]);
  });

  it('reads attachments as paths into the fixture directory', () => {
    const cases = loadEvalCases(caseDir);
    const withAttachment = cases.find((entry) => entry.inputRefs.attachmentPaths.length > 0);
    expect(withAttachment).toBeDefined();
    const messages = readCaseMessages(repoRoot, withAttachment!.inputRefs.emailPaths);
    const attachments = messages.flatMap((message) => message.attachments);
    expect(attachments.length).toBeGreaterThan(0);
    for (const attachment of attachments) {
      // A fixture attachment that resolved to no path would silently make every document assertion
      // vacuous, so the path is asserted present before it is read.
      expect(attachment.storagePath).not.toBeNull();
      expect(() => readFileSync(attachment.storagePath as string)).not.toThrow();
    }
  });
});

describe('report semantics', () => {
  it('is green only when every case passed', () => {
    expect(
      isGreen(report({ passed: 2, cases: [caseResult('a', 'passed'), caseResult('b', 'passed')] })),
    ).toBe(true);
    // A run that errored is not a run that passed, even though it recorded no assertion failures.
    expect(isGreen(report({ passed: 1, failed: 0, cases: [caseResult('a', 'error')] }))).toBe(
      false,
    );
    expect(isGreen(report({ passed: 1, failed: 1, cases: [caseResult('a', 'passed')] }))).toBe(
      false,
    );
  });

  it('hands the repair loop the first failing case in stable order', () => {
    const failing = report({
      cases: [
        caseResult('case-01', 'passed'),
        caseResult('case-02', 'failed'),
        caseResult('case-03', 'failed'),
      ],
    });
    expect(firstActionableFailure(failing)?.caseKey).toBe('case-02');
    expect(firstActionableFailure(report({ cases: [caseResult('case-01', 'passed')] }))).toBeNull();
  });

  it('summarizes counts and every failing assertion', () => {
    const text = summarize(
      report({
        passed: 1,
        failed: 1,
        cases: [
          caseResult('case-01', 'passed'),
          {
            ...caseResult('case-02', 'failed'),
            failures: [
              {
                assertion: 'outcome',
                expected: 'ready',
                actual: 'needs_information',
                message: 'outcome differs',
              },
            ],
            failureClass: 'implementation',
          },
        ],
      }),
    );
    expect(text).toContain('1 passed, 1 failed of 2');
    expect(text).toContain('outcome differs');
    expect(text).toContain('class: implementation');
  });
});
