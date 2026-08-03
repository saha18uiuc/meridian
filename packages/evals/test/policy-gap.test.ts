import { describe, expect, it } from 'vitest';
import { MAX_REPAIR_ITERATIONS, nextRepairAction } from '../src/classify-failure.js';

/**
 * The stop rule.
 *
 * A self-healing loop is only safe because of what it refuses to do. Three of the four possible
 * answers here stop the loop: a green suite, a gap that belongs to the person who owns the process,
 * and an environment failure that no code change can fix. Only the fourth reserves another version,
 * and even that is bounded, because a loop that keeps going cannot tell "nearly there" from
 * "editing at random".
 *
 * The case that would be most damaging to get wrong is the policy gap. Repairing one means writing
 * a business rule nobody agreed to and then shipping it with a green suite behind it, which is
 * exactly the failure mode the whole review-and-freeze pipeline exists to prevent.
 */

describe('repair loop decisions', () => {
  it('does nothing when the suite is green', () => {
    expect(nextRepairAction({ green: true, failure: null, iterationsUsed: 0 })).toEqual({
      kind: 'done',
    });
  });

  it('records a gap and stops, rather than repairing, when policy is missing', () => {
    const action = nextRepairAction({
      green: false,
      failure: { caseKey: 'case-07', failureClass: 'policy_gap' },
      iterationsUsed: 0,
    });
    expect(action).toEqual({
      kind: 'record_policy_gap',
      caseKey: 'case-07',
      failureKey: 'case-07_policy_gap',
    });
  });

  it('treats an unclassified failure as a policy gap', () => {
    // Ambiguity resolves towards stopping. The cost of a needless stop is a human's attention; the
    // cost of a needless repair is invented policy in shipped code.
    const action = nextRepairAction({
      green: false,
      failure: { caseKey: 'case-09', failureClass: null },
      iterationsUsed: 0,
    });
    expect(action.kind).toBe('record_policy_gap');
  });

  it('stops without recording a gap when the failure is environmental', () => {
    const action = nextRepairAction({
      green: false,
      failure: { caseKey: 'case-11', failureClass: 'tool_infrastructure' },
      iterationsUsed: 0,
    });
    expect(action.kind).toBe('stop');
    expect(action).toMatchObject({ reason: expect.stringContaining('case-11') });
  });

  it('repairs an implementation or extraction failure inside the bound', () => {
    for (const failureClass of ['implementation', 'extraction'] as const) {
      expect(
        nextRepairAction({
          green: false,
          failure: { caseKey: 'case-02', failureClass },
          iterationsUsed: MAX_REPAIR_ITERATIONS - 1,
        }),
      ).toEqual({ kind: 'repair', caseKey: 'case-02', failureClass });
    }
  });

  it('stops once the iteration bound is reached', () => {
    const action = nextRepairAction({
      green: false,
      failure: { caseKey: 'case-02', failureClass: 'implementation' },
      iterationsUsed: MAX_REPAIR_ITERATIONS,
    });
    expect(action.kind).toBe('stop');
    expect(action).toMatchObject({
      reason: expect.stringContaining(String(MAX_REPAIR_ITERATIONS)),
    });
  });

  it('stops when the suite is red but names no failing case', () => {
    // An inconsistent report is a harness bug. Guessing a case to repair would turn it into an
    // agent bug in the commit history.
    expect(nextRepairAction({ green: false, failure: null, iterationsUsed: 0 }).kind).toBe('stop');
  });
});
