import type { AgentDefinition, AgentRegistry } from '@meridian/agent-kit/contracts';
import { resolveAgent as resolveFromRegistry } from '@meridian/agent-kit/contracts';
import { agent as inboundImportReceivingV001 } from './inbound-import-receiving/v001/agent.js';
import { agent as inboundImportReceivingV002 } from './inbound-import-receiving/v002/agent.js';
import { agent as vendorCoiRenewalV001 } from './vendor-coi-renewal/v001/agent.js';

/**
 * GENERATED FILE — regenerate with `pnpm exec tsx scripts/generate-registry.ts`.
 *
 * The map is static and synchronous on purpose. It is bundled into the Temporal workflow sandbox,
 * where dynamic `import()` and filesystem globbing are unavailable, so every registered version has
 * to be reachable through a top-level import statement written here.
 *
 * Everything imported here also enters the sandbox bundle, which is why the resolver comes from
 * `@meridian/agent-kit/contracts` rather than from the package root: the root pulls in the live
 * Composio, OpenAI, and OCR adapters, none of which can be bundled for a workflow.
 *
 * Adding a version therefore requires regenerating this file and restarting the worker.
 */

export const AGENT_REGISTRY = {
  'inbound-import-receiving': {
    1: inboundImportReceivingV001,
    2: inboundImportReceivingV002,
  },
  'vendor-coi-renewal': {
    1: vendorCoiRenewalV001,
  },
} as const satisfies AgentRegistry;

export function resolveAgent(deploymentKey: string, versionNo: number): AgentDefinition {
  return resolveFromRegistry(AGENT_REGISTRY, deploymentKey, versionNo);
}
