import 'server-only';

import type { Database } from '@meridian/core/database';
import type { SpecJson } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

export interface FrozenSpecRecord {
  specId: string;
  whiteboardId: string;
  specVersion: number;
  specJson: SpecJson;
  specHash: string;
  sourceCanvasHash: string;
  sourceRevisionNo: number;
  unresolvedCommentIds: string[];
  frozenAt: string;
}

const COLUMNS =
  'spec_id, whiteboard_id, spec_version, spec_json, spec_hash, source_canvas_hash, source_revision_no, unresolved_comment_ids, created_at';

type Row = {
  spec_id: string;
  whiteboard_id: string;
  spec_version: number;
  spec_json: unknown;
  spec_hash: string;
  source_canvas_hash: string;
  source_revision_no: number;
  unresolved_comment_ids: string[] | null;
  created_at: string;
};

function toRecord(row: Row): FrozenSpecRecord {
  return {
    specId: row.spec_id,
    whiteboardId: row.whiteboard_id,
    specVersion: row.spec_version,
    specJson: row.spec_json as SpecJson,
    specHash: row.spec_hash,
    sourceCanvasHash: row.source_canvas_hash,
    sourceRevisionNo: row.source_revision_no,
    unresolvedCommentIds: row.unresolved_comment_ids ?? [],
    frozenAt: row.created_at,
  };
}

export async function getSpec(client: Client, specId: string): Promise<FrozenSpecRecord> {
  const { data, error } = await client
    .from('frozen_specs')
    .select(COLUMNS)
    .eq('spec_id', specId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('SPEC');
  return toRecord(data);
}

export interface SpecIndexEntry {
  specId: string;
  whiteboardId: string;
  boardTitle: string | null;
  specVersion: number;
  specHash: string;
  sourceRevisionNo: number;
  unresolvedCommentCount: number;
  frozenAt: string;
}

/**
 * Every specification the caller owns, newest first.
 *
 * The board title is embedded rather than fetched per row: an index of specs that shows only UUIDs
 * and version numbers answers "how many" and not "which process". RLS on `frozen_specs` scopes this
 * to the owner, and the embed follows the same policy on `whiteboards`, so no filter is applied
 * here and none is needed.
 *
 * `spec_json` is excluded. It is the largest column in the database and the one thing a list has no
 * use for.
 */
export async function listSpecs(client: Client, limit = 100): Promise<SpecIndexEntry[]> {
  const { data, error } = await client
    .from('frozen_specs')
    .select(
      'spec_id, whiteboard_id, spec_version, spec_hash, source_revision_no, unresolved_comment_ids, created_at, whiteboards(title)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error !== null) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const typed = row as unknown as Row & { whiteboards: { title: string } | null };
    return {
      specId: typed.spec_id,
      whiteboardId: typed.whiteboard_id,
      boardTitle: typed.whiteboards?.title ?? null,
      specVersion: typed.spec_version,
      specHash: typed.spec_hash,
      sourceRevisionNo: typed.source_revision_no,
      unresolvedCommentCount: (typed.unresolved_comment_ids ?? []).length,
      frozenAt: typed.created_at,
    };
  });
}

export async function listBoardSpecs(
  client: Client,
  whiteboardId: string,
): Promise<FrozenSpecRecord[]> {
  const { data, error } = await client
    .from('frozen_specs')
    .select(COLUMNS)
    .eq('whiteboard_id', whiteboardId)
    .order('spec_version', { ascending: false });
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toRecord(row as Row));
}
