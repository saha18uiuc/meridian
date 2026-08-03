import { writeFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '@meridian/core';
import { loadOpsEnv } from './env.js';
import { optionalArg, parseArgs, requireArg } from './lib/args.js';
import { ensureParentDir } from './lib/state.js';
import { opsClient } from './lib/supabase.js';

/**
 * The only sanctioned read path for a frozen specification.
 *
 * A generating agent must not reach into the database, and it must not be handed a spec that has
 * drifted from the hash the lineage records. So this exports the canonical bytes and re-derives
 * the hash from them: if the stored `spec_hash` and the re-canonicalized bytes disagree, something
 * has changed under the schema and the only safe answer is to stop.
 */

export const EXIT_NOT_FOUND = 2;
export const EXIT_HASH_MISMATCH = 3;

export interface ExportResult {
  specId: string;
  specHash: string;
  specVersion: number;
  whiteboardId: string;
  outPath: string;
}

export class SpecExportError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'SpecExportError';
    this.exitCode = exitCode;
  }
}

export async function exportFrozenSpec(specId: string, outPath: string): Promise<ExportResult> {
  const client = opsClient();
  const { data, error } = await client
    .from('frozen_specs')
    .select('spec_id, whiteboard_id, spec_version, spec_json, spec_hash')
    .eq('spec_id', specId)
    .maybeSingle();

  if (error !== null) throw new SpecExportError(error.message, EXIT_NOT_FOUND);
  if (data === null) throw new SpecExportError(`no frozen spec ${specId}`, EXIT_NOT_FOUND);

  const canonical = canonicalJson(data.spec_json);
  const recomputed = sha256Hex(data.spec_json);
  if (recomputed !== data.spec_hash) {
    throw new SpecExportError(
      `spec ${specId} re-canonicalizes to ${recomputed} but the row records ${data.spec_hash}`,
      EXIT_HASH_MISMATCH,
    );
  }

  ensureParentDir(outPath);
  writeFileSync(outPath, `${canonical}\n`, 'utf8');

  return {
    specId: data.spec_id,
    specHash: data.spec_hash,
    specVersion: data.spec_version,
    whiteboardId: data.whiteboard_id,
    outPath,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  const specId = requireArg(args, 'spec');
  const outPath = optionalArg(args, 'out') ?? `/tmp/meridian-spec-${specId}.json`;
  try {
    const result = await exportFrozenSpec(specId, outPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = error instanceof SpecExportError ? error.exitCode : 1;
  }
}
