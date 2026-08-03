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
