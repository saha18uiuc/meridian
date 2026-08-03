import type { FileRef } from '@meridian/agent-kit/contracts';
import { withFailureMapping } from './failures.js';
import { type ActivityEnvelope, toolsFor } from './runtime.js';

export async function documentExtractText(
  envelope: ActivityEnvelope,
  fileRef: FileRef,
): Promise<string> {
  return withFailureMapping(async () => toolsFor(envelope).documents.extractText(fileRef));
}

export async function documentExtractFields(
  envelope: ActivityEnvelope,
  fileRef: FileRef,
  schemaName: string,
): Promise<Record<string, unknown>> {
  return withFailureMapping(async () =>
    toolsFor(envelope).documents.extractFields(fileRef, schemaName),
  );
}

export async function documentNormalizeValue(
  envelope: ActivityEnvelope,
  value: string,
  type: 'hts' | 'ndc' | 'date' | 'number' | 'text',
): Promise<string> {
  return withFailureMapping(async () => toolsFor(envelope).documents.normalizeValue(value, type));
}
