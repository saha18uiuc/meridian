import 'server-only';

import type { Database } from '@meridian/core/database';
import type { ReasoningEffort, ReviewSessionStatus } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

export interface ReviewSessionSummary {
  reviewSessionId: string;
  whiteboardId: string;
  roundNo: number;
  sourceRevisionNo: number;
  sourceCanvasHash: string;
  modelName: string;
  reasoningEffort: ReasoningEffort;
  status: ReviewSessionStatus;
  counts: { inserted: number; recurred: number; resolved: number };
  summary: Record<string, unknown> | null;
  errorJson: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

const COLUMNS =
  'review_session_id, whiteboard_id, round_no, source_revision_no, source_canvas_hash, model_name, reasoning_effort, status, review_summary_json, error_json, created_at, completed_at';

type Row = {
  review_session_id: string;
  whiteboard_id: string;
  round_no: number;
  source_revision_no: number;
  source_canvas_hash: string;
  model_name: string;
  reasoning_effort: string;
  status: string;
  review_summary_json: unknown;
  error_json: unknown;
  created_at: string;
  completed_at: string | null;
};

function toSummary(row: Row): ReviewSessionSummary {
  const summary = (row.review_summary_json ?? null) as Record<string, unknown> | null;
  const counts = (summary?.['counts'] ?? {}) as Partial<ReviewSessionSummary['counts']>;
  return {
    reviewSessionId: row.review_session_id,
    whiteboardId: row.whiteboard_id,
    roundNo: row.round_no,
    sourceRevisionNo: row.source_revision_no,
    sourceCanvasHash: row.source_canvas_hash,
    modelName: row.model_name,
    reasoningEffort: row.reasoning_effort as ReasoningEffort,
    status: row.status as ReviewSessionStatus,
    counts: {
      inserted: counts.inserted ?? 0,
      recurred: counts.recurred ?? 0,
      resolved: counts.resolved ?? 0,
    },
    summary,
    errorJson: (row.error_json ?? null) as Record<string, unknown> | null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function listReviewSessions(
  client: Client,
  whiteboardId: string,
  limit = 20,
): Promise<ReviewSessionSummary[]> {
  const { data, error } = await client
    .from('review_sessions')
    .select(COLUMNS)
    .eq('whiteboard_id', whiteboardId)
    .order('round_no', { ascending: false })
    .limit(limit);
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toSummary(row as Row));
}

export async function getReviewSession(
  client: Client,
  reviewSessionId: string,
): Promise<ReviewSessionSummary> {
  const { data, error } = await client
    .from('review_sessions')
    .select(COLUMNS)
    .eq('review_session_id', reviewSessionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('REVIEW_SESSION');
  return toSummary(data);
}

/** The most recent completed round, which is what the board page shows threads for. */
export async function latestCompletedSession(
  client: Client,
  whiteboardId: string,
): Promise<ReviewSessionSummary | null> {
  const { data, error } = await client
    .from('review_sessions')
    .select(COLUMNS)
    .eq('whiteboard_id', whiteboardId)
    .eq('status', 'completed')
    .order('round_no', { ascending: false })
    .limit(1);
  if (error !== null) throw new Error(error.message);
  const row = (data ?? [])[0];
  return row === undefined ? null : toSummary(row);
}
