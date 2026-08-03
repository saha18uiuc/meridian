import type { AgentContext, AgentDefinition } from './contracts.js';
import { ValidationError } from './errors.js';

/**
 * Validates on the way in and on the way out, then runs the agent.
 *
 * Both validations matter for different reasons. The input check keeps a malformed extraction from
 * being interpreted as business truth; the decision check keeps a generated agent from returning a
 * shape the persistence layer and the eval assertions do not agree on. A generated agent never
 * calls this itself — the workflow does — so the guarantee cannot be skipped by the generated code.
 */
export async function runAgent<TInput, TDecision>(
  definition: AgentDefinition<TInput, TDecision>,
  rawInput: unknown,
  context: AgentContext,
): Promise<TDecision> {
  const parsedInput = definition.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new ValidationError(`Input for agent ${definition.id}`, parsedInput.error.issues);
  }

  const decision = await definition.run(parsedInput.data, context);

  const parsedDecision = definition.decisionSchema.safeParse(decision);
  if (!parsedDecision.success) {
    throw new ValidationError(`Decision from agent ${definition.id}`, parsedDecision.error.issues);
  }
  return parsedDecision.data;
}
