import type { AgentDecision } from '@meridian/core/schemas';
import type { AgentDefinition } from './contracts.js';

/**
 * The single constructor a generated agent uses. It exists so every generated folder has the same
 * shape and so the `id` is derived rather than typed by hand, which keeps the registry key and the
 * code path from drifting apart.
 */
export function defineAgent<TInput, TDecision = AgentDecision>(
  definition: Omit<AgentDefinition<TInput, TDecision>, 'id'> & { id?: string },
): AgentDefinition<TInput, TDecision> {
  const id =
    definition.id ??
    `${definition.deploymentKey}@v${String(definition.versionNo).padStart(3, '0')}`;
  return { ...definition, id };
}
