import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  ActionDataSchema,
  FIELD_TYPES,
  INPUT_KINDS,
  InputDataSchema,
  OutcomeDataSchema,
  PRIMITIVE_TYPES,
  RESULT_KINDS,
  RULE_KINDS,
  RuleDataSchema,
  parseNodeData,
  safeParseNodeData,
} from '../src/schemas/primitives.js';

/**
 * §5.2 fixes four primitives and the exact fields of each. This file is the executable version
 * of that list: adding, removing, or renaming a field breaks it on purpose.
 */
describe('the four primitives', () => {
  it('has exactly four, named input, action, rule, and outcome', () => {
    expect([...PRIMITIVE_TYPES]).toEqual(['input', 'action', 'rule', 'outcome']);
  });
});

describe('Input card data', () => {
  const required = ['inputKind', 'sourceSystem', 'required', 'fields', 'correlationKeys'];

  it('exposes exactly the fields §5.2 lists', () => {
    const parsed = InputDataSchema.parse({ inputKind: 'event' });
    expect(Object.keys(parsed).sort()).toEqual([...required].sort());
  });

  it('constrains inputKind to event, document, data', () => {
    expect([...INPUT_KINDS]).toEqual(['event', 'document', 'data']);
    expect(InputDataSchema.safeParse({ inputKind: 'telepathy' }).success).toBe(false);
  });

  it('constrains field types to the five listed types', () => {
    expect([...FIELD_TYPES]).toEqual(['string', 'number', 'date', 'boolean', 'enum']);
    expect(
      InputDataSchema.safeParse({
        inputKind: 'data',
        fields: [{ name: 'x', type: 'blob', required: true }],
      }).success,
    ).toBe(false);
  });

  it('preserves field and correlation-key order, because order is author-meaningful', () => {
    const parsed = InputDataSchema.parse({
      inputKind: 'data',
      correlationKeys: ['mawb', 'containerNumber'],
    });
    expect(parsed.correlationKeys).toEqual(['mawb', 'containerNumber']);
  });
});

describe('Action card data', () => {
  it('exposes exactly the fields §5.2 lists', () => {
    const parsed = ActionDataSchema.parse({ actor: 'agent', operation: 'mail.read' });
    expect(Object.keys(parsed).sort()).toEqual(
      ['actor', 'operation', 'instructions', 'system', 'inputs', 'outputs'].sort(),
    );
  });

  it('constrains the actor to agent, human, system', () => {
    expect([...ACTORS]).toEqual(['agent', 'human', 'system']);
    expect(ActionDataSchema.safeParse({ actor: 'robot', operation: 'x' }).success).toBe(false);
  });

  it('requires a non-empty operation', () => {
    expect(ActionDataSchema.safeParse({ actor: 'agent', operation: '   ' }).success).toBe(false);
  });
});

describe('Rule card data', () => {
  it('exposes exactly the fields §5.2 lists', () => {
    const parsed = RuleDataSchema.parse({ ruleKind: 'decision' });
    expect(Object.keys(parsed).sort()).toEqual(
      ['ruleKind', 'condition', 'branches', 'fallbackNodeId'].sort(),
    );
  });

  it('constrains ruleKind to decision, wait, retry, exception', () => {
    expect([...RULE_KINDS]).toEqual(['decision', 'wait', 'retry', 'exception']);
  });

  it('requires maxAttempts for a retry rule', () => {
    expect(RuleDataSchema.safeParse({ ruleKind: 'retry' }).success).toBe(false);
    expect(RuleDataSchema.safeParse({ ruleKind: 'retry', maxAttempts: 3 }).success).toBe(true);
  });

  it('requires timeoutMinutes for a wait rule', () => {
    expect(RuleDataSchema.safeParse({ ruleKind: 'wait' }).success).toBe(false);
    expect(RuleDataSchema.safeParse({ ruleKind: 'wait', timeoutMinutes: 60 }).success).toBe(true);
  });

  it('does not require either for a decision rule', () => {
    expect(RuleDataSchema.safeParse({ ruleKind: 'decision' }).success).toBe(true);
  });
});

describe('Outcome card data', () => {
  it('constrains resultKind to the five listed results', () => {
    expect([...RESULT_KINDS]).toEqual([
      'ready',
      'needs_information',
      'manual_review',
      'rejected',
      'completed',
    ]);
  });

  it('treats requiredAction as optional', () => {
    const parsed = OutcomeDataSchema.parse({ resultKind: 'ready' });
    expect(parsed.requiredAction).toBeUndefined();
    expect(parsed.terminal).toBe(false);
  });

  it('accepts a required action with a capability', () => {
    const parsed = OutcomeDataSchema.parse({
      resultKind: 'needs_information',
      terminal: true,
      requiredAction: {
        actionType: 'email',
        description: 'ask for the CoA',
        capability: 'mail.send',
      },
    });
    expect(parsed.requiredAction?.capability).toBe('mail.send');
  });
});

describe('parseNodeData dispatch', () => {
  it('selects the schema its primitive type names', () => {
    expect(parseNodeData('input', { inputKind: 'event' })).toMatchObject({ inputKind: 'event' });
    expect(() => parseNodeData('rule', { ruleKind: 'retry' })).toThrow();
  });

  it('has a non-throwing variant for review checks', () => {
    expect(safeParseNodeData('action', { actor: 'nobody' }).success).toBe(false);
  });

  it('rejects unknown keys on every primitive', () => {
    expect(safeParseNodeData('input', { inputKind: 'event', extra: 1 }).success).toBe(false);
    expect(safeParseNodeData('action', { actor: 'agent', operation: 'x', extra: 1 }).success).toBe(
      false,
    );
    expect(safeParseNodeData('rule', { ruleKind: 'decision', extra: 1 }).success).toBe(false);
    expect(safeParseNodeData('outcome', { resultKind: 'ready', extra: 1 }).success).toBe(false);
  });
});
