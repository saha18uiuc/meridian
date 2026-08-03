import { KNOWN_CAPABILITIES } from '@meridian/core/schemas';
import type { AgentContext } from './contracts.js';
import { CapabilityDeniedError } from './errors.js';

/**
 * The allow-list is the frozen spec's `capabilities` array, not a runtime configuration value.
 * A capability that was never reviewed and never frozen cannot be exercised, which is what stops a
 * generated agent from quietly widening its own blast radius between versions.
 */
export function assertCapability(context: AgentContext, capability: string): void {
  if (!context.capabilities.includes(capability)) {
    throw new CapabilityDeniedError(capability, context.capabilities);
  }
}

export function hasCapability(context: AgentContext, capability: string): boolean {
  return context.capabilities.includes(capability);
}

/** Browser writes need both the frozen capability and the operator's environment switch. */
export function assertBrowserWriteAllowed(context: AgentContext, enabled: boolean): void {
  assertCapability(context, 'browser.write');
  if (!enabled) {
    throw new CapabilityDeniedError('browser.write', context.capabilities);
  }
}

export function isKnownCapabilityName(capability: string): boolean {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(capability);
}

export { KNOWN_CAPABILITIES };
