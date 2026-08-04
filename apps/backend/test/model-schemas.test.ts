import { CoaSchema, GoodSchema, InvoiceSchema } from '@meridian/core/schemas';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_SCHEMAS } from '../src/temporal/activities/model.js';

/**
 * The model is only useful if it answers in the names the agent reads, so these assert that the
 * schema sent to OpenAI still matches the canonical shape. A field renamed in `@meridian/core`
 * without a matching change here would otherwise surface as a document silently filed unreadable.
 */

function coreKeys(schema: z.ZodObject<z.ZodRawShape>, omit: readonly string[] = []): string[] {
  return Object.keys(schema.shape)
    .filter((key) => !omit.includes(key))
    .sort();
}

function sentKeys(schemaName: string, path: 'root' | 'goods' = 'root'): string[] {
  const schema = EXTRACTION_SCHEMAS[schemaName] as {
    properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
  };
  const properties =
    path === 'root' ? schema.properties : (schema.properties.goods?.items?.properties ?? {});
  return Object.keys(properties).sort();
}

describe('extraction schemas sent to the model', () => {
  it('asks for exactly the invoice fields the agent reads, minus the one it supplies itself', () => {
    expect(sentKeys('invoice')).toEqual(coreKeys(InvoiceSchema, ['sourcePath']));
  });

  it('asks for every good field, since all five identifiers drive validation', () => {
    expect(sentKeys('invoice', 'goods')).toEqual(coreKeys(GoodSchema));
  });

  it('asks for exactly the certificate fields', () => {
    expect(sentKeys('coa')).toEqual(coreKeys(CoaSchema, ['sourcePath']));
  });

  it('requires every property, which strict structured outputs demand', () => {
    for (const [name, schema] of Object.entries(EXTRACTION_SCHEMAS)) {
      const typed = schema as { required: string[]; properties: Record<string, unknown> };
      expect(typed.required.sort(), name).toEqual(Object.keys(typed.properties).sort());
      expect(schema.additionalProperties, name).toBe(false);
    }
  });
});
