import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

export const STORAGE_BUCKETS = ['emails', 'attachments', 'ocr', 'screenshots'] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/**
 * Large artifacts never travel through `payload_json`. They are uploaded here and referenced by
 * path, so the events table stays cheap to page through and a single OCR dump cannot make an
 * execution's history unreadable.
 *
 * The layout `<bucket>/<executionId>/<stepInstanceKey>/<filename>` is chosen so that everything an
 * execution produced can be listed with one prefix query, and so a step's artifacts stay grouped
 * even when the same step is retried.
 */
export function artifactPath(input: {
  bucket: StorageBucket;
  executionId: string;
  stepInstanceKey: string;
  filename: string;
}): string {
  const safeInstance = input.stepInstanceKey.replace(/[^A-Za-z0-9._:-]/g, '_');
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${input.bucket}/${input.executionId}/${safeInstance}/${safeName}`;
}

export function splitStoragePath(path: string): { bucket: string; objectPath: string } {
  const index = path.indexOf('/');
  if (index < 1) throw new Error(`Storage path '${path}' has no bucket prefix.`);
  return { bucket: path.slice(0, index), objectPath: path.slice(index + 1) };
}

export interface ArtifactStore {
  put(path: string, body: Uint8Array | string, contentType: string): Promise<string>;
  get(path: string): Promise<Uint8Array>;
  signedUrl(path: string, expiresInSeconds?: number): Promise<string>;
}

export function createArtifactStore(client: SupabaseClient<Database>): ArtifactStore {
  return {
    async put(path, body, contentType) {
      const { bucket, objectPath } = splitStoragePath(path);
      const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const { error } = await client.storage
        .from(bucket)
        .upload(objectPath, payload, { contentType, upsert: true });
      if (error !== null) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
      return path;
    },
    async get(path) {
      const { bucket, objectPath } = splitStoragePath(path);
      const { data, error } = await client.storage.from(bucket).download(objectPath);
      if (error !== null) throw new Error(`Storage download failed for ${path}: ${error.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async signedUrl(path, expiresInSeconds = 300) {
      const { bucket, objectPath } = splitStoragePath(path);
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(objectPath, expiresInSeconds);
      if (error !== null) throw new Error(`Signing failed for ${path}: ${error.message}`);
      return data.signedUrl;
    },
  };
}
