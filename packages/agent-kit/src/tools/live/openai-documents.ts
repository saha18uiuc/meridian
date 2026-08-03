import type { DocumentTool, FileRef } from '../../contracts.js';
import { ExtractionError, ToolUnavailableError } from '../../errors.js';
import type { ArtifactStore } from '../../storage.js';
import { normalizeScalar } from '../documents.js';

export interface LiveDocumentOptions {
  store: ArtifactStore;
  ocrEnabled: boolean;
  ocrMinTextChars: number;
  /** Returns structured fields for the given text; injected so tests need no network. */
  extractStructured(text: string, schemaName: string): Promise<Record<string, unknown>>;
}

/**
 * Text first, model second.
 *
 * `pdf-parse` is deterministic and free, so it runs before anything else. OCR is the expensive,
 * non-deterministic fallback and stays off unless explicitly enabled — a scanned document with OCR
 * disabled therefore fails loudly, naming the file, instead of silently yielding a few characters
 * of noise that the extraction step would then interpret as missing data.
 */
export function createLiveDocumentTool(options: LiveDocumentOptions): DocumentTool {
  async function rawText(fileRef: FileRef): Promise<string> {
    const bytes = await options.store.get(fileRef.storagePath);
    if (fileRef.mimeType === 'application/pdf' || fileRef.filename.endsWith('.pdf')) {
      const { PDFParse } = (await import('pdf-parse')) as unknown as {
        PDFParse: new (init: { data: Uint8Array }) => {
          getText(): Promise<{ text: string }>;
          destroy(): Promise<void>;
        };
      };
      const parser = new PDFParse({ data: bytes });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  return {
    async extractText(fileRef) {
      const text = await rawText(fileRef);
      if (text.trim().length >= options.ocrMinTextChars) return text;

      if (!options.ocrEnabled) {
        throw new ExtractionError(
          fileRef.filename,
          `only ${String(text.trim().length)} characters of embedded text and OCR_ENABLED is false`,
        );
      }
      const { createWorker } = (await import('tesseract.js')) as unknown as {
        createWorker: (lang: string) => Promise<{
          recognize(image: Uint8Array): Promise<{ data: { text: string } }>;
          terminate(): Promise<void>;
        }>;
      };
      const worker = await createWorker('eng');
      try {
        const bytes = await options.store.get(fileRef.storagePath);
        const result = await worker.recognize(bytes);
        return result.data.text;
      } finally {
        await worker.terminate();
      }
    },

    async extractFields(fileRef, schemaName) {
      const text = await this.extractText(fileRef);
      if (text.trim() === '') {
        throw new ToolUnavailableError('documents', `no text extracted from ${fileRef.filename}`);
      }
      return options.extractStructured(text, schemaName);
    },

    async normalizeValue(value, type) {
      return normalizeScalar(value, type);
    },
  };
}
