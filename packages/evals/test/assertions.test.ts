import type { EvalCase, ExecutionAction, ExecutionStep } from '@meridian/core/schemas';
import { describe, expect, it } from 'vitest';
import {
  assertEvidence,
  assertExternalActions,
  assertGitLineage,
  assertRetries,
  assertStepLineage,
  runAssertions,
  type RunObservation,
} from '../src/assertions.js';

/**
 * What a passing eval case actually means.
 *
 * These assertions are the only thing standing between "the agent ran" and "the agent was right",
 * so each test here is written as the failure it is meant to catch: a second send after a crash, a
 * step attempt recorded twice under one identity, a green run against a version with no commit.
 */

const SHA = 'a'.repeat(40);
const SPEC_HASH = 'b'.repeat(64);

function evalCase(expected: Partial<EvalCase['expected']> = {}): EvalCase {
  return {
    caseKey: 'case-01',
    description: 'happy path',
    specTrace: 'spec.process.terminalNodeIds',
    inputRefs: {
      emailPaths: ['examples/inbound-import-receiving/fixtures/emails/happy-path.eml'],
      attachmentPaths: [],
      expectedPath: 'examples/inbound-import-receiving/fixtures/expected/case-01.expected.json',
    },
    expected: { outcome: 'ready', ...expected },
  };
}

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepExecutionId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    nodeId: crypto.randomUUID(),
    stepKey: 'extract',
    stepInstanceKey: 'extract#1',
    sequenceNo: 1,
    attemptNo: 1,
    status: 'succeeded',
    inputSummaryJson: {},
    outputSummaryJson: {},
    errorJson: null,
    startedAt: '2026-02-11T00:00:00.000Z',
    completedAt: '2026-02-11T00:00:01.000Z',
    ...overrides,
  };
}

function action(overrides: Partial<ExecutionAction> = {}): ExecutionAction {
  return {
    executionActionId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    stepExecutionId: null,
    actionType: 'mail.send',
    status: 'succeeded',
    idempotencyKey: 'send#1',
    markerToken: 'marker-1',
    providerActionId: 'provider-1',
    requestPayloadJson: {},
    providerResponseJson: {},
    reconciliationJson: null,
    attemptCount: 1,
    createdAt: '2026-02-11T00:00:00.000Z',
    dispatchedAt: '2026-02-11T00:00:01.000Z',
    completedAt: '2026-02-11T00:00:02.000Z',
    ...overrides,
  };
}

function observation(overrides: Partial<RunObservation> = {}): RunObservation {
  return {
    decision: {
      outcome: 'ready',
      businessKey: 'MSKU1234565',
      reason: 'all documents present',
      summary: {
        containerNumber: 'MSKU1234565',
        mawb: null,
        invoiceNumbers: ['INV-1'],
        batchNumbers: ['B77A'],
        goodsCount: 1,
        validGoodsCount: 1,
        missingInformation: [],
      },
      findings: [],
      emailResponse: null,
    },
    steps: [step()],
    actions: [],
    evidenceKeys: [],
    storagePaths: [],
    gitCommitSha: SHA,
    manifestSpecHash: SPEC_HASH,
    executionSpecHash: SPEC_HASH,
    humanDecisionRequested: false,
    ...overrides,
  };
}

describe('eval assertions', () => {
  it('passes a run that matches its case', () => {
    expect(runAssertions(evalCase(), observation())).toEqual([]);
  });

  it('catches a duplicate send even when both rows look successful', () => {
    // This is the crash-and-replay bug: two reservations under one idempotency key. Counting
    // succeeded rows alone would call it a pass with `count: 2`.
    const failures = assertExternalActions(
      evalCase({
        externalActions: [{ actionType: 'mail.send', count: 2, finalStatus: 'succeeded' }],
      }),
      observation({ actions: [action(), action()] }),
    );
    expect(failures.map((failure) => failure.assertion)).toContain(
      'externalActions.noDuplicateSends',
    );
  });

  it('fails a case that expects no action but performed one', () => {
    const failures = assertExternalActions(evalCase(), observation({ actions: [action()] }));
    expect(failures.map((failure) => failure.assertion)).toContain('externalActions.none');
  });

  it('fails when an expected action ended in the wrong state', () => {
    const failures = assertExternalActions(
      evalCase({
        externalActions: [{ actionType: 'mail.send', count: 1, finalStatus: 'succeeded' }],
      }),
      observation({ actions: [action({ status: 'needs_reconciliation' })] }),
    );
    expect(failures.map((failure) => failure.assertion)).toContain(
      'externalActions.mail.send.status',
    );
  });

  it('catches one step instance recording the same attempt twice', () => {
    const failures = assertStepLineage(
      evalCase(),
      observation({
        steps: [
          step({ stepInstanceKey: 'extract#1', attemptNo: 1 }),
          step({ stepInstanceKey: 'extract#1', attemptNo: 1 }),
        ],
      }),
    );
    expect(failures.map((failure) => failure.assertion)).toContain('stepLineage.unique');
  });

  it('allows parallel siblings to share a display ordinal', () => {
    // `sequence_no` is display ordering, not identity. Two goods extracted in parallel share an
    // ordinal legitimately, and asserting on it would make parallelism look like a bug.
    const failures = assertStepLineage(
      evalCase({ stepInstanceKeys: ['extract#1', 'extract#2'] }),
      observation({
        steps: [
          step({ stepInstanceKey: 'extract#1', sequenceNo: 3 }),
          step({ stepInstanceKey: 'extract#2', sequenceNo: 3 }),
        ],
      }),
    );
    expect(failures).toEqual([]);
  });

  it('counts retries as attempts beyond the first', () => {
    expect(
      assertRetries(
        evalCase({ retries: { extract: 2 } }),
        observation({
          steps: [
            step({ stepKey: 'extract', attemptNo: 1, status: 'failed' }),
            step({ stepKey: 'extract', attemptNo: 2, status: 'failed' }),
            step({ stepKey: 'extract', attemptNo: 3 }),
          ],
        }),
      ),
    ).toEqual([]);

    expect(
      assertRetries(evalCase({ retries: { extract: 2 } }), observation()).map(
        (failure) => failure.assertion,
      ),
    ).toEqual(['retries.extract']);
  });

  it('names the evidence a case expected and did not get', () => {
    const failures = assertEvidence(
      evalCase({ evidenceKeys: ['coa-matched', 'invoice-parsed'] }),
      observation({ evidenceKeys: ['coa-matched'] }),
    );
    expect(failures[0]?.message).toContain('invoice-parsed');
  });

  it('refuses to pass a run whose version records no commit', () => {
    // A green suite over an unrecorded version measures code nobody can point at, so this is
    // asserted on every case rather than only where a case opts in.
    const failures = assertGitLineage(evalCase(), observation({ gitCommitSha: null }));
    expect(failures.map((failure) => failure.assertion)).toContain('gitLineage.sha');
  });

  it('refuses to pass when the manifest and the execution disagree about the spec', () => {
    const failures = assertGitLineage(
      evalCase(),
      observation({ manifestSpecHash: 'c'.repeat(64) }),
    );
    expect(failures.map((failure) => failure.assertion)).toContain('gitLineage.specHash');
  });

  it('reports every broken expectation, not just the first', () => {
    const failures = runAssertions(
      evalCase({ businessKey: 'TGHU7654320', missingFields: ['fdaProductCode'] }),
      observation({ gitCommitSha: null }),
    );
    expect(failures.length).toBeGreaterThan(2);
  });
});
