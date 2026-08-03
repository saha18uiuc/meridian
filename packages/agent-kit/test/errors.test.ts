import { describe, expect, it } from 'vitest';
import {
  ActionNeedsReconciliationError,
  AGENT_ERROR_CODES,
  AgentNotRegisteredError,
  CapabilityDeniedError,
  DomainNotAllowedError,
  ExternalActionError,
  ExtractionError,
  HumanDecisionTimeoutError,
  isAgentError,
  NON_RETRYABLE_FAILURE_TYPES,
  NonRetryableToolError,
  PolicyGapError,
  RetryableToolError,
  SpecHashMismatchError,
  ToolUnavailableError,
  ValidationError,
} from '../src/errors.js';

const canonical = [
  new RetryableToolError('mailbox', 'provider 503'),
  new NonRetryableToolError('mailbox', 'live mode off'),
  new CapabilityDeniedError('mail.send', []),
  new ExtractionError('scan.pdf', 'no embedded text'),
  new PolicyGapError('what happens when a CoA arrives after clearance?'),
  new ValidationError('Input', []),
  new ActionNeedsReconciliationError('id', 'abcdef123456'),
  new AgentNotRegisteredError('inbound-import-receiving', 2),
  new HumanDecisionTimeoutError('handoff:1', '24 hours'),
];

describe('the error hierarchy', () => {
  it('covers exactly the declared codes', () => {
    expect(canonical.map((error) => error.code).sort()).toEqual([...AGENT_ERROR_CODES].sort());
  });

  it('recognises every member through the type guard and keeps its class name', () => {
    for (const error of canonical) {
      expect(isAgentError(error)).toBe(true);
      expect(error.name).toBe(error.constructor.name);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('rejects plain objects and plain errors', () => {
    expect(isAgentError({ code: 'CAPABILITY_DENIED' })).toBe(false);
    expect(isAgentError(new Error('plain'))).toBe(false);
  });

  it('marks everything except a transient tool failure as non-retryable', () => {
    const retryable = canonical.filter((error) => !error.nonRetryable).map((error) => error.code);
    expect(retryable).toEqual(['RETRYABLE_TOOL_ERROR']);
  });

  it('maps to exactly two Temporal failure types', () => {
    expect(new RetryableToolError('m', 'r').failureType).toBe('RetryableToolError');
    expect(new PolicyGapError('q').failureType).toBe('NonRetryableToolError');
  });

  it('lists the five failure types the retry policy refuses to retry', () => {
    expect([...NON_RETRYABLE_FAILURE_TYPES]).toEqual([
      'NonRetryableToolError',
      'CapabilityDeniedError',
      'PolicyGapError',
      'ValidationError',
      'ActionNeedsReconciliationError',
    ]);
  });

  it('serializes to a code, a message, and structured details', () => {
    const json = new CapabilityDeniedError('mail.send', ['mail.draft']).toJSON();
    expect(json.code).toBe('CAPABILITY_DENIED');
    expect(json.details).toEqual({ capability: 'mail.send', granted: ['mail.draft'] });
    expect(json.message).toContain('mail.send');
  });

  it('keeps specific tool errors on the correct branch', () => {
    // These inherit their retry semantics rather than restating them, so a new subclass cannot
    // accidentally make a hopeless failure retryable.
    expect(new SpecHashMismatchError('a', 'b').nonRetryable).toBe(true);
    expect(new ToolUnavailableError('documents', 'busy').nonRetryable).toBe(true);
    expect(new DomainNotAllowedError('https://evil.test', []).nonRetryable).toBe(true);
    expect(new ExternalActionError('mail.send', 'provider 500').nonRetryable).toBe(false);
  });
});
