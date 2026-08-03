import { workerEnv } from '@meridian/core';
import { NonRetryableToolError } from '@meridian/agent-kit';
import { withFailureMapping } from './failures.js';

/**
 * The model boundary.
 *
 * Model calls live in an activity rather than in the workflow for the obvious reason — they are
 * non-deterministic I/O — but also because a model response is exactly the kind of large payload
 * that must be summarised before it reaches an event row.
 */
export async function modelExtractStructured(args: {
  schemaName: string;
  instructions: string;
  text: string;
}): Promise<Record<string, unknown>> {
  return withFailureMapping(async () => {
    const env = workerEnv();
    if (env.AI_MODE !== 'live' || env.OPENAI_API_KEY === undefined) {
      throw new NonRetryableToolError(
        'model',
        'structured extraction requires AI_MODE=live and OPENAI_API_KEY',
      );
    }
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: env.AI_REVIEW_MODEL,
      reasoning: { effort: env.AI_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: `${args.instructions}\nReturn strict JSON for schema "${args.schemaName}". Use null for anything absent; never invent a value.`,
        },
        { role: 'user', content: args.text.slice(0, 100_000) },
      ],
    });
    return JSON.parse(response.output_text) as Record<string, unknown>;
  });
}
