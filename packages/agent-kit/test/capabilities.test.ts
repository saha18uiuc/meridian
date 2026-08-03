import { describe, expect, it } from 'vitest';
import { assertBrowserWriteAllowed, assertCapability, hasCapability } from '../src/capabilities.js';
import type { AgentContext } from '../src/contracts.js';
import { CapabilityDeniedError } from '../src/errors.js';

function contextWith(capabilities: string[]): AgentContext {
  return { capabilities } as unknown as AgentContext;
}

describe('assertCapability', () => {
  it('passes when the frozen spec granted the capability', () => {
    expect(() => assertCapability(contextWith(['mail.send']), 'mail.send')).not.toThrow();
  });

  it('throws CapabilityDeniedError naming the capability and the granted set', () => {
    try {
      assertCapability(contextWith(['mail.draft']), 'mail.send');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityDeniedError);
      const denied = error as CapabilityDeniedError;
      expect(denied.code).toBe('CAPABILITY_DENIED');
      expect(denied.nonRetryable).toBe(true);
      expect(denied.details).toEqual({ capability: 'mail.send', granted: ['mail.draft'] });
    }
  });

  it('does not treat a prefix as a grant', () => {
    expect(() => assertCapability(contextWith(['mail']), 'mail.send')).toThrow(
      CapabilityDeniedError,
    );
  });
});

describe('hasCapability', () => {
  it('reports membership without throwing', () => {
    expect(hasCapability(contextWith(['browser.read']), 'browser.read')).toBe(true);
    expect(hasCapability(contextWith(['browser.read']), 'browser.write')).toBe(false);
  });
});

describe('assertBrowserWriteAllowed', () => {
  it('requires both the frozen capability and the environment switch', () => {
    const granted = contextWith(['browser.write']);
    expect(() => assertBrowserWriteAllowed(granted, true)).not.toThrow();
    expect(() => assertBrowserWriteAllowed(granted, false)).toThrow(CapabilityDeniedError);
    expect(() => assertBrowserWriteAllowed(contextWith([]), true)).toThrow(CapabilityDeniedError);
  });
});
