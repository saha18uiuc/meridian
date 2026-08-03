import { NonRetryableToolError } from '@meridian/agent-kit';
import { workerEnv } from '@meridian/core';
import { withFailureMapping } from './failures.js';

/**
 * The model boundary: the one place in the worker that talks to OpenAI.
 *
 * It is not itself a Temporal activity, and deliberately so. The only thing an agent can ask the
 * model for is structured fields from a document, and it asks through `DocumentTool.extractFields`
 * — so the call already crosses into an activity at `documentExtractFields`, and registering a
 * second activity beside it would advertise a durable operation nothing invokes. What matters for
 * determinism is that the call happens *inside* an activity rather than in the workflow, which it
 * does; which activity is an implementation detail.
 *
 * It lives here rather than in `agent-kit` because the mock path must never import an SDK, and
 * because `createLiveDocumentTool` already takes this function as an injected dependency. The
 * worker supplies it in `runtime.ts`; the eval harness and every mock run supply nothing and reach
 * a deterministic fixture instead.
 */
export async function modelExtractStructured(
  text: string,
  schemaName: string,
): Promise<Record<string, unknown>> {
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
      // The configured effort, the same one the review path reads. Extraction is the more
      // mechanical of the two jobs and could justify a lower setting, but a second knob that
      // nothing sets is how the two call sites disagreed in the first place.
      reasoning: { effort: env.AI_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: `Extract the fields for schema "${schemaName}" as strict JSON. Use null for anything absent; never invent a value.`,
        },
        // Bounded because a model response is exactly the kind of payload that must be summarised
        // before it reaches an event row, and an unbounded prompt is the other half of that risk.
        { role: 'user', content: text.slice(0, 100_000) },
      ],
    });
    return JSON.parse(response.output_text) as Record<string, unknown>;
  });
}
