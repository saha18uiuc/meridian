import { describe, expect, it } from 'vitest';
import { deriveDeterministicIssueKey, deriveModelIssueKey } from '../src/issue-key.js';
import { uuid } from './helpers/factories.js';

const nodeAnchor = { anchorType: 'node' as const, anchorId: uuid(7), anchorFieldPath: null };

describe('issue key derivation', () => {
  it('is a pure function: identical inputs give identical keys', () => {
    expect(deriveDeterministicIssueKey('UNLABELED_RULE_BRANCH', nodeAnchor)).toBe(
      deriveDeterministicIssueKey('UNLABELED_RULE_BRANCH', nodeAnchor),
    );
  });

  it('separates deterministic keys from model keys by prefix', () => {
    expect(deriveDeterministicIssueKey('DISCONNECTED_NODE', nodeAnchor)).toMatch(/^det:/);
    expect(deriveModelIssueKey('ambiguous_business_rule', nodeAnchor)).toMatch(/^mod:/);
  });

  it('gives different keys for the same anchor with a different code', () => {
    expect(deriveDeterministicIssueKey('DISCONNECTED_NODE', nodeAnchor)).not.toBe(
      deriveDeterministicIssueKey('UNREACHABLE_OUTCOME', nodeAnchor),
    );
  });

  it('gives different keys for the same code at a different anchor', () => {
    const other = { ...nodeAnchor, anchorId: uuid(8) };
    expect(deriveDeterministicIssueKey('DISCONNECTED_NODE', nodeAnchor)).not.toBe(
      deriveDeterministicIssueKey('DISCONNECTED_NODE', other),
    );
  });

  it('distinguishes field paths on the same node', () => {
    expect(
      deriveDeterministicIssueKey('MISSING_REQUIRED_PRIMITIVE_FIELD', {
        ...nodeAnchor,
        anchorFieldPath: 'actor',
      }),
    ).not.toBe(
      deriveDeterministicIssueKey('MISSING_REQUIRED_PRIMITIVE_FIELD', {
        ...nodeAnchor,
        anchorFieldPath: 'system',
      }),
    );
  });

  it("renders a canvas anchor as 'canvas' and a missing field path as '-'", () => {
    expect(
      deriveDeterministicIssueKey('MISSING_INITIAL_PATH', {
        anchorType: 'canvas',
        anchorId: null,
        anchorFieldPath: null,
      }),
    ).toBe('det:missing_initial_path:canvas:canvas:-');
  });

  it('emits a key the comments table will accept', () => {
    // `ck_comments_issue_key_shape` admits only `[a-z0-9_:.-]` after the prefix. Check codes are
    // written in upper case and field paths in camel case, so a key that was not normalized here
    // would be rejected at insert time — and only for the boards that actually have defects,
    // which is the worst possible moment to find out.
    const shape = /^(det|mod):[a-z0-9_:.-]+$/;
    expect(
      deriveDeterministicIssueKey('MISSING_REQUIRED_PRIMITIVE_FIELD', {
        ...nodeAnchor,
        anchorFieldPath: 'maxAttempts',
      }),
    ).toMatch(shape);
    expect(deriveDeterministicIssueKey('DISCONNECTED_NODE', nodeAnchor)).toMatch(shape);
    expect(deriveModelIssueKey('Ambiguous_Business_Rule', nodeAnchor)).toMatch(shape);
  });

  it('lower-cases and trims a model code before using it', () => {
    expect(deriveModelIssueKey('  Ambiguous_Business_Rule ', nodeAnchor)).toBe(
      deriveModelIssueKey('ambiguous_business_rule', nodeAnchor),
    );
  });
});
