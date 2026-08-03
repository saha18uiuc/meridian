import { describe, expect, it, vi } from 'vitest';
import type { FileRef } from '../src/contracts.js';
import { ExtractionError } from '../src/errors.js';
import { normalizeScalar } from '../src/tools/documents.js';
import { createLiveDocumentTool } from '../src/tools/live/openai-documents.js';
import { createMockDocumentTool } from '../src/tools/mock/documents.js';

const ATTACHMENT_DIR = new URL(
  '../../../examples/inbound-import-receiving/fixtures/attachments',
  import.meta.url,
).pathname;

function fileRef(filename: string): FileRef {
  return {
    filename,
    storagePath: `attachments/${filename}`,
    mimeType: 'application/pdf',
  };
}

describe('normalizeScalar', () => {
  it('strips punctuation from HTS and NDC codes', () => {
    expect(normalizeScalar('3004.10.1000', 'hts')).toBe('3004101000');
    expect(normalizeScalar('0093-4155-73', 'ndc')).toBe('0093415573');
  });

  it('collapses whitespace in free text', () => {
    expect(normalizeScalar('  Amoxicillin   Capsules ', 'text')).toBe('Amoxicillin Capsules');
  });

  it('normalizes an ISO date and an unambiguous slash date', () => {
    expect(normalizeScalar('2026-02-07', 'date')).toBe('2026-02-07');
    expect(normalizeScalar('27/02/2026', 'date')).toBe('2026-02-27');
  });

  it('leaves an ambiguous date untouched rather than guessing the order', () => {
    expect(normalizeScalar('02/03/2026', 'date')).toBe('02/03/2026');
  });
});

describe('mock document tool', () => {
  const tool = createMockDocumentTool({ attachmentDir: ATTACHMENT_DIR });

  it('returns the same text for the same fixture on every call', async () => {
    const first = await tool.extractText(fileRef('invoice-1024.pdf'));
    const second = await tool.extractText(fileRef('invoice-1024.pdf'));
    expect(first).toBe(second);
    expect(first).toContain('INV-1024');
  });

  it('returns fixture-driven structured fields', async () => {
    const fields = (await tool.extractFields(fileRef('invoice-1024.pdf'), 'invoice')) as {
      invoiceNumber: string;
      goods: { batchNumber: string }[];
    };
    expect(fields.invoiceNumber).toBe('INV-1024');
    expect(fields.goods.map((good) => good.batchNumber)).toEqual(['B77A', 'B77B']);
  });

  it('surfaces genuinely absent regulatory fields as null instead of omitting them', async () => {
    const fields = (await tool.extractFields(fileRef('invoice-1025.pdf'), 'invoice')) as {
      goods: { andaNumber: string | null; ndcNumber: string | null }[];
    };
    expect(fields.goods[0]?.andaNumber).toBeNull();
    expect(fields.goods[0]?.ndcNumber).toBeNull();
  });

  it('fails loudly for an attachment with no fixture entry', async () => {
    await expect(tool.extractText(fileRef('unknown.pdf'))).rejects.toThrow(/no fixture entry/);
  });
});

describe('live document tool OCR gate', () => {
  function storeReturning(text: string) {
    return {
      get: vi.fn(async () => new TextEncoder().encode(text)),
      put: vi.fn(async () => ''),
      signedUrl: vi.fn(async () => ''),
    };
  }

  it('throws ExtractionError naming the file when text is short and OCR is disabled', async () => {
    const tool = createLiveDocumentTool({
      store: storeReturning('tiny'),
      ocrEnabled: false,
      ocrMinTextChars: 200,
      extractStructured: async () => ({}),
    });
    await expect(
      tool.extractText({
        filename: 'scan.txt',
        storagePath: 'ocr/scan.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it('returns embedded text without OCR when it clears the threshold', async () => {
    const long = 'x'.repeat(500);
    const tool = createLiveDocumentTool({
      store: storeReturning(long),
      ocrEnabled: false,
      ocrMinTextChars: 200,
      extractStructured: async () => ({}),
    });
    await expect(
      tool.extractText({ filename: 'a.txt', storagePath: 'ocr/a.txt', mimeType: 'text/plain' }),
    ).resolves.toBe(long);
  });
});
