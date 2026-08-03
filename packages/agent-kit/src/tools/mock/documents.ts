import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DocumentTool, FileRef } from '../../contracts.js';
import { ToolUnavailableError } from '../../errors.js';
import { normalizeScalar } from '../documents.js';

interface FixtureEntry {
  text: string;
  fields: Record<string, unknown>;
}

type FixtureIndex = Record<string, FixtureEntry>;

/**
 * Fixture-driven extraction.
 *
 * The mock deliberately does not parse the PDFs. Running a real parser here would make the eval
 * suite depend on `pdf-parse` behaviour and on OCR quality, which are exactly the things the live
 * adapter is responsible for and the eval suite is not trying to measure. What the suite does need
 * is a stable answer for a given attachment, which an index file gives.
 *
 * A missing entry is an error rather than an empty result, because silently returning no fields
 * would look identical to a document that genuinely lacks them.
 */
export function createMockDocumentTool(options: { attachmentDir: string }): DocumentTool {
  const indexPath = join(options.attachmentDir, 'index.json');
  let index: FixtureIndex | null = null;

  function load(): FixtureIndex {
    if (index !== null) return index;
    if (!existsSync(indexPath)) {
      throw new ToolUnavailableError('documents', `fixture index missing at ${indexPath}`);
    }
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as FixtureIndex;
    return index;
  }

  function entryFor(fileRef: FileRef): FixtureEntry {
    const key = basename(fileRef.filename !== '' ? fileRef.filename : fileRef.storagePath);
    const entry = load()[key];
    if (entry === undefined) {
      throw new ToolUnavailableError('documents', `no fixture entry for ${key}`);
    }
    return entry;
  }

  return {
    async extractText(fileRef) {
      return entryFor(fileRef).text;
    },
    async extractFields(fileRef, schemaName) {
      const entry = entryFor(fileRef);
      const scoped = entry.fields[schemaName];
      return (scoped ?? entry.fields) as Record<string, unknown>;
    },
    async normalizeValue(value, type) {
      return normalizeScalar(value, type);
    },
  };
}
