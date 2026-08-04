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
const GOOD_PROPERTIES = {
  lineKey: { type: 'string' },
  description: { type: 'string' },
  batchNumber: { type: ['string', 'null'] },
  htsCode: { type: ['string', 'null'] },
  fdaProductCode: { type: ['string', 'null'] },
  andaNumber: { type: ['string', 'null'] },
  registrationNumber: { type: ['string', 'null'] },
  ndcNumber: { type: ['string', 'null'] },
} as const;

/**
 * The shape behind each schema name, sent to the model rather than named at it.
 *
 * A name is not a contract. Asked only for schema "invoice", the model returns a document that is
 * entirely correct under names of its own choosing — `invoice_number`, `lines[].line_id`, `batch` —
 * and the agent, which reads `invoiceNumber` and `goods[].lineKey`, finds nothing and files a
 * perfectly legible invoice as unreadable. The mock path hid this for as long as it existed,
 * because its fixture answered in the shape the agent wanted.
 *
 * `sourcePath` is deliberately absent: the agent already knows where the document came from and
 * fills it in itself, so asking the model would only invite an invented answer.
 *
 * These mirror `GoodSchema`, `InvoiceSchema`, and `CoaSchema` in `@meridian/core/schemas`;
 * `model-schemas.test.ts` fails if the two drift apart.
 */
export const EXTRACTION_SCHEMAS: Record<string, Record<string, unknown>> = {
  invoice: {
    type: 'object',
    additionalProperties: false,
    required: ['invoiceNumber', 'goods'],
    properties: {
      invoiceNumber: { type: 'string' },
      goods: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(GOOD_PROPERTIES),
          properties: GOOD_PROPERTIES,
        },
      },
    },
  },
  coa: {
    type: 'object',
    additionalProperties: false,
    required: ['batchNumber'],
    properties: { batchNumber: { type: 'string' } },
  },
};

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

    const schema = EXTRACTION_SCHEMAS[schemaName];
    if (schema === undefined) {
      // Falling back to an unconstrained prompt is what produced the mismatch this map exists to
      // prevent, so an unknown name stops here instead.
      throw new NonRetryableToolError(
        'model',
        `no extraction schema is defined for '${schemaName}'`,
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
          content: `Extract the ${schemaName} fields from the document. Use null for anything the document does not state; never invent a value.`,
        },
        // Bounded because a model response is exactly the kind of payload that must be summarised
        // before it reaches an event row, and an unbounded prompt is the other half of that risk.
        { role: 'user', content: text.slice(0, 100_000) },
      ],
      text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
    });
    return JSON.parse(response.output_text) as Record<string, unknown>;
  });
}
