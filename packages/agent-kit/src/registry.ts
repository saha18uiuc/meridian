import type { AgentDefinition, AgentRegistry } from './contracts.js';
import { AgentNotRegisteredError, SpecHashMismatchError } from './errors.js';

/**
 * Lookup over a static, synchronous map. There is no dynamic `import()` and no filesystem globbing
 * anywhere in this path, because the map has to survive being bundled into the Temporal workflow
 * sandbox, where neither is available.
 *
 * Adding a generated version therefore requires regenerating `generated-agents/index.ts` and
 * restarting the worker. That is a deliberate trade: a slightly heavier release step in exchange
 * for a workflow bundle whose contents are known at build time.
 */
export function resolveAgent(
  registry: AgentRegistry,
  deploymentKey: string,
  versionNo: number,
): AgentDefinition {
  const versions = registry[deploymentKey];
  if (versions === undefined) throw new AgentNotRegisteredError(deploymentKey, versionNo);
  const definition = versions[versionNo];
  if (definition === undefined) throw new AgentNotRegisteredError(deploymentKey, versionNo);
  return definition;
}

/**
 * The pinned spec hash is checked before `run()` is ever called. If a folder were edited after its
 * version was frozen, this is where the mismatch surfaces, rather than as puzzling behaviour later.
 */
export function resolvePinnedAgent(
  registry: AgentRegistry,
  pinned: { deploymentKey: string; versionNo: number; specHash: string },
): AgentDefinition {
  const definition = resolveAgent(registry, pinned.deploymentKey, pinned.versionNo);
  if (definition.specHash !== pinned.specHash) {
    throw new SpecHashMismatchError(pinned.specHash, definition.specHash);
  }
  return definition;
}

export function registeredVersions(registry: AgentRegistry): { key: string; versionNo: number }[] {
  return Object.keys(registry)
    .sort()
    .flatMap((key) =>
      Object.keys(registry[key] ?? {})
        .map(Number)
        .sort((a, b) => a - b)
        .map((versionNo) => ({ key, versionNo })),
    );
}
