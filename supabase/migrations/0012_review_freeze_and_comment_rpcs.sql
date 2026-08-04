-- ===========================================================================
-- Shared helpers used by this migration and by 0013.
-- ===========================================================================

-- [A26] THE single definition of "unresolved". Everything else calls this.
create or replace function meridian.is_unresolved_root(p_parent uuid, p_status text)
returns boolean language sql immutable set search_path = '' as $$
  select p_parent is null and p_status in ('open','answered');
$$;

-- Whether the operator has recorded an assumption that still stands on this thread. Resolution of
-- a model finding depends on it, so it is a named predicate rather than an inline EXISTS: this is
-- the evidence that distinguishes "the ambiguity was addressed" from "the model stopped bringing
-- it up". `record_explicit_assumption` stamps `supersededAt` on the entry it replaces, so the live
-- assumption is the one without it.
create or replace function meridian.root_has_live_assumption(p_root_comment_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.comments a
     where a.parent_comment_id = p_root_comment_id
       and a.metadata_json->>'kind' = 'assumption'
       and a.metadata_json->>'supersededAt' is null
  );
$$;

-- [A21] Structural proof that a server-supplied snapshot really describes this
-- board at this revision. The database cannot recompute a canonical SHA-256,
-- but it CAN prove the snapshot enumerates exactly the rows that exist, with
-- exactly the row versions that exist. A fabricated snapshot fails here.
create or replace function meridian.assert_snapshot_matches_board(
  p_whiteboard_id uuid, p_revision_no integer, p_snapshot jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare v_bad integer;
begin
  if not meridian.is_json_object(p_snapshot)
     or not meridian.is_json_array(p_snapshot->'nodes')
     or not meridian.is_json_array(p_snapshot->'edges')
     or not meridian.is_json_object(p_snapshot->'metadata') then
    raise exception 'INVALID_SNAPSHOT_SHAPE' using errcode = 'P0001';
  end if;
  if (p_snapshot->'metadata'->>'whiteboardId')::uuid is distinct from p_whiteboard_id
     or (p_snapshot->'metadata'->>'revisionNo')::integer is distinct from p_revision_no then
    raise exception 'SNAPSHOT_METADATA_MISMATCH' using errcode = 'P0001';
  end if;

  select count(*) into v_bad from (
    select (e->>'nodeId')::uuid as id, (e->>'rowVersion')::integer as rv
      from jsonb_array_elements(p_snapshot->'nodes') e
    except
    select node_id, row_version from public.whiteboard_nodes
     where whiteboard_id = p_whiteboard_id) x;
  if v_bad > 0 then
    raise exception 'SNAPSHOT_DOES_NOT_MATCH_BOARD: % phantom node(s)', v_bad using errcode = 'P0001';
  end if;

  select count(*) into v_bad from (
    select node_id, row_version from public.whiteboard_nodes where whiteboard_id = p_whiteboard_id
    except
    select (e->>'nodeId')::uuid, (e->>'rowVersion')::integer
      from jsonb_array_elements(p_snapshot->'nodes') e) x;
  if v_bad > 0 then
    raise exception 'SNAPSHOT_DOES_NOT_MATCH_BOARD: % missing node(s)', v_bad using errcode = 'P0001';
  end if;

  select count(*) into v_bad from (
    select (e->>'edgeId')::uuid, (e->>'rowVersion')::integer
      from jsonb_array_elements(p_snapshot->'edges') e
    except
    select edge_id, row_version from public.whiteboard_edges where whiteboard_id = p_whiteboard_id) x;
  if v_bad > 0 then
    raise exception 'SNAPSHOT_DOES_NOT_MATCH_BOARD: % phantom edge(s)', v_bad using errcode = 'P0001';
  end if;

  select count(*) into v_bad from (
    select edge_id, row_version from public.whiteboard_edges where whiteboard_id = p_whiteboard_id
    except
    select (e->>'edgeId')::uuid, (e->>'rowVersion')::integer
      from jsonb_array_elements(p_snapshot->'edges') e) x;
  if v_bad > 0 then
    raise exception 'SNAPSHOT_DOES_NOT_MATCH_BOARD: % missing edge(s)', v_bad using errcode = 'P0001';
  end if;
end;
$$;

-- Locks a board on behalf of an explicit actor (service-role callers have no
-- auth.uid(), so ownership is re-checked against p_actor_user_id — A21).
create or replace function meridian.lock_board_for_actor(p_actor_user_id uuid, p_whiteboard_id uuid)
returns public.whiteboards language plpgsql set search_path = '' as $$
declare v_board public.whiteboards%rowtype;
begin
  if p_actor_user_id is null then
    raise exception 'ACTOR_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_board from public.whiteboards
   where whiteboard_id = p_whiteboard_id and owner_id = p_actor_user_id
   for update;
  if not found then
    raise exception 'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  return v_board;
end;
$$;

-- ===========================================================================
-- RPC 5 — create_review_session  [service_role only, A20, A21]
-- ===========================================================================
create or replace function public.create_review_session(
  p_actor_user_id        uuid,
  p_whiteboard_id        uuid,
  p_expected_revision_no integer,
  p_snapshot             jsonb,
  p_snapshot_hash        char(64),
  p_model_name           text,
  p_reasoning_effort     text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_board  public.whiteboards%rowtype;
  v_round  smallint;
  v_id     uuid;
begin
  if not meridian.is_sha256_hex(p_snapshot_hash) then
    raise exception 'INVALID_SNAPSHOT_HASH' using errcode = 'P0001';
  end if;
  if p_model_name is null or length(btrim(p_model_name)) = 0 then
    raise exception 'MODEL_NAME_REQUIRED' using errcode = 'P0001';
  end if;
  if p_reasoning_effort not in ('low','medium','high','n/a') then
    raise exception 'INVALID_REASONING_EFFORT: %', p_reasoning_effort using errcode = 'P0001';
  end if;

  v_board := meridian.lock_board_for_actor(p_actor_user_id, p_whiteboard_id);
  if v_board.status = 'archived' then
    raise exception 'WHITEBOARD_ARCHIVED: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  if v_board.revision_no <> p_expected_revision_no then
    raise exception 'STALE_BOARD_REVISION: current=%', v_board.revision_no using errcode = 'P0001';
  end if;
  if exists (select 1 from public.review_sessions
              where whiteboard_id = p_whiteboard_id and status in ('queued','running')) then
    raise exception 'ACTIVE_REVIEW_EXISTS: %', p_whiteboard_id using errcode = 'P0001';
  end if;

  perform meridian.assert_snapshot_matches_board(p_whiteboard_id, v_board.revision_no, p_snapshot);

  select coalesce(max(round_no), 0)::smallint + 1 into v_round
    from public.review_sessions where whiteboard_id = p_whiteboard_id;

  -- [A20] Inserted DIRECTLY as 'running' with the ACTUAL model already
  -- resolved by the caller, so the immutable model columns are never mutated.
  insert into public.review_sessions
    (whiteboard_id, round_no, source_revision_no, source_canvas_json, source_canvas_hash,
     status, requested_by, model_name, reasoning_effort)
  values
    (p_whiteboard_id, v_round, v_board.revision_no, p_snapshot, p_snapshot_hash,
     'running', p_actor_user_id, btrim(p_model_name), p_reasoning_effort)
  returning review_session_id into v_id;

  if v_board.status = 'draft' then
    update public.whiteboards set status = 'review_ready' where whiteboard_id = p_whiteboard_id;
  end if;

  return jsonb_build_object(
    'reviewSessionId', v_id, 'roundNo', v_round,
    'sourceRevisionNo', v_board.revision_no, 'sourceCanvasHash', p_snapshot_hash,
    'modelName', btrim(p_model_name), 'reasoningEffort', p_reasoning_effort,
    'status', 'running');
end;
$$;

-- ===========================================================================
-- RPC 6 — finalize_review_session  [service_role only]
-- ===========================================================================
create or replace function public.finalize_review_session(
  p_actor_user_id    uuid,
  p_review_session_id uuid,
  p_findings          jsonb,
  p_summary           jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sess     public.review_sessions%rowtype;
  v_board    public.whiteboards%rowtype;
  v_f        jsonb;
  v_key      text;
  v_root     uuid;
  v_root_status text;
  v_inserted integer := 0;
  v_recurred integer := 0;
  v_resolved integer := 0;
  v_keys     text[]  := '{}';
  v_rejected uuid[]  := '{}';
begin
  perform set_config('meridian.in_review_finalize', 'on', true);

  select * into v_sess from public.review_sessions
   where review_session_id = p_review_session_id for update;
  if not found then
    raise exception 'REVIEW_SESSION_NOT_FOUND: %', p_review_session_id using errcode = 'P0001';
  end if;

  -- Idempotent replay: a completed session returns its recorded result.
  if v_sess.status = 'completed' then
    perform set_config('meridian.in_review_finalize', 'off', true);
    return jsonb_build_object('reviewSessionId', p_review_session_id, 'wasAlreadyCompleted', true)
        || coalesce(v_sess.review_summary_json->'counts', '{}'::jsonb);
  end if;
  if v_sess.status <> 'running' then
    raise exception 'REVIEW_SESSION_NOT_RUNNING: %', v_sess.status using errcode = 'P0001';
  end if;

  v_board := meridian.lock_board_for_actor(p_actor_user_id, v_sess.whiteboard_id);

  if not meridian.is_json_array(p_findings) then
    raise exception 'INVALID_FINDING_SHAPE: findings must be an array' using errcode = 'P0001';
  end if;

  for v_f in select * from jsonb_array_elements(p_findings) loop
    v_key := v_f->>'issueKey';
    if v_key is null or v_key !~ '^(det|mod):[a-z0-9_]+:(node|edge|canvas):[a-z0-9-]+:.+$' then
      raise exception 'INVALID_FINDING_SHAPE: issueKey %', coalesce(v_key,'<null>') using errcode = 'P0001';
    end if;
    if (v_f->>'severity') not in ('blocking','non_blocking') then
      raise exception 'INVALID_FINDING_SHAPE: severity' using errcode = 'P0001';
    end if;
    v_keys := v_keys || v_key;

    -- Does a LIVE root already carry this issue on this board?
    select comment_id, status into v_root, v_root_status from public.comments
     where whiteboard_id = v_sess.whiteboard_id
       and parent_comment_id is null
       and issue_key = v_key
       and status in ('open','answered','rejected')
     limit 1
     for update;

    if v_root is not null and v_root_status = 'rejected' then
      -- Recorded, never reopened (A26). "We ruled this out and it keeps coming back" is worth
      -- being able to see, so the recurrence is still appended below; what it must not do is
      -- return the root to the unresolved set.
      v_rejected := v_rejected || v_root;
    end if;

    if v_root is null then
      -- ck_comments_root_thread_identity is checked at INSERT, so the identifier is minted here
      -- and written to both columns at once. Inserting a placeholder and correcting it afterwards
      -- would need a deferred constraint, which is a weaker guarantee for no benefit.
      v_root := gen_random_uuid();
      insert into public.comments
        (comment_id, whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
         author_user_id, body, anchor_type, anchor_id, anchor_field_path,
         status, severity, issue_key, suggested_patch_json, metadata_json)
      values
        (v_root, v_sess.whiteboard_id, p_review_session_id, v_root, null, 'ai',
         null, v_f->>'body', v_f->>'anchorType', nullif(v_f->>'anchorId','')::uuid,
         v_f->>'anchorFieldPath', 'open', v_f->>'severity', v_key,
         v_f->'suggestedPatch',
         jsonb_build_object('kind','review_issue','issueKey',v_key,
                            'checkCode', v_f->'checkCode', 'origin', v_f->>'origin'));
      v_inserted := v_inserted + 1;
    else
      insert into public.comments
        (whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
         author_user_id, body, anchor_type, anchor_id, status, severity, metadata_json)
      select v_sess.whiteboard_id, p_review_session_id, c.thread_id, v_root, 'system',
             null, 'Recurred in round ' || v_sess.round_no || ': ' || (v_f->>'body'),
             c.anchor_type, c.anchor_id, null, null, '{"kind":"reply"}'::jsonb
        from public.comments c where c.comment_id = v_root;
      v_recurred := v_recurred + 1;
    end if;
  end loop;

  -- Resolution (§5.5.3). Absence from a round is necessary but NOT sufficient, and which extra
  -- evidence is required depends on where the finding came from:
  --
  --   det: — a deterministic check is not a matter of opinion. Its issue_key is present in
  --          `v_keys` exactly while the check still fires, so absence *is* the evidence.
  --   mod: — a model that stops repeating itself has demonstrated nothing; it may have run out of
  --          attention or phrased the concern differently. Silence therefore leaves the root live.
  --          It resolves only once the operator has recorded an explicit assumption on the thread,
  --          which is the artefact that says a human decided what the ambiguity means.
  --
  -- Rejected roots are never touched (A26): `is_unresolved_root` already excludes them.
  with resolved as (
    update public.comments c
       set status = 'resolved', resolved_at = now()
     where c.whiteboard_id = v_sess.whiteboard_id
       and meridian.is_unresolved_root(c.parent_comment_id, c.status)
       and not (c.issue_key = any(v_keys))
       and (c.issue_key like 'det:%' or meridian.root_has_live_assumption(c.comment_id))
    returning 1)
  select count(*) into v_resolved from resolved;

  update public.review_sessions
     set status = 'completed',
         completed_at = now(),
         review_summary_json = coalesce(p_summary, '{}'::jsonb)
           || jsonb_build_object('counts', jsonb_build_object(
                'inserted', v_inserted, 'recurred', v_recurred, 'resolved', v_resolved))
           || jsonb_build_object('recurredRejected', to_jsonb(v_rejected))
   where review_session_id = p_review_session_id;

  -- [A18] Review currency.
  update public.whiteboards
     set last_reviewed_revision_no = v_sess.source_revision_no
   where whiteboard_id = v_sess.whiteboard_id;

  perform set_config('meridian.in_review_finalize', 'off', true);
  return jsonb_build_object(
    'reviewSessionId', p_review_session_id, 'wasAlreadyCompleted', false,
    'inserted', v_inserted, 'recurred', v_recurred, 'resolved', v_resolved,
    'recurredRejected', to_jsonb(v_rejected),
    'lastReviewedRevisionNo', v_sess.source_revision_no);
end;
$$;

-- ===========================================================================
-- RPC 7 — fail_review_session  [service_role only]
-- ===========================================================================
create or replace function public.fail_review_session(
  p_actor_user_id     uuid,
  p_review_session_id uuid,
  p_error             jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sess public.review_sessions%rowtype;
begin
  select * into v_sess from public.review_sessions
   where review_session_id = p_review_session_id for update;
  if not found then
    raise exception 'REVIEW_SESSION_NOT_FOUND: %', p_review_session_id using errcode = 'P0001';
  end if;
  if v_sess.status = 'failed' then
    return jsonb_build_object('reviewSessionId', p_review_session_id, 'status', 'failed',
                              'wasAlreadyFailed', true);
  end if;
  perform meridian.lock_board_for_actor(p_actor_user_id, v_sess.whiteboard_id);

  update public.review_sessions
     set status = 'failed', completed_at = now(),
         error_json = coalesce(p_error, jsonb_build_object('code','UNKNOWN'))
   where review_session_id = p_review_session_id;

  -- last_reviewed_revision_no is deliberately NOT touched.
  return jsonb_build_object('reviewSessionId', p_review_session_id, 'status', 'failed',
                            'wasAlreadyFailed', false);
end;
$$;

-- ===========================================================================
-- RPC 8 — reply_to_comment  [authenticated]
-- ===========================================================================
create or replace function public.reply_to_comment(p_comment_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_root public.comments%rowtype; v_new uuid;
begin
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'EMPTY_BODY' using errcode = 'P0001';
  end if;
  select c.* into v_root from public.comments c
    join public.whiteboards w on w.whiteboard_id = c.whiteboard_id
   where c.comment_id = p_comment_id and w.owner_id = auth.uid()
   for update of c;
  if not found then
    raise exception 'COMMENT_NOT_FOUND_OR_FORBIDDEN: %', p_comment_id using errcode = 'P0001';
  end if;
  if v_root.parent_comment_id is not null then
    raise exception 'CANNOT_REPLY_TO_REPLY: %', p_comment_id using errcode = 'P0001';
  end if;

  insert into public.comments
    (whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
     author_user_id, body, anchor_type, anchor_id, metadata_json)
  values
    (v_root.whiteboard_id, v_root.review_session_id, v_root.thread_id, v_root.comment_id, 'user',
     auth.uid(), btrim(p_body), v_root.anchor_type, v_root.anchor_id, '{"kind":"reply"}'::jsonb)
  returning comment_id into v_new;

  -- A reply yields 'answered', NEVER 'resolved'.
  if v_root.status = 'open' then
    update public.comments set status = 'answered' where comment_id = v_root.comment_id;
    v_root.status := 'answered';
  end if;

  return jsonb_build_object('commentId', v_new, 'threadId', v_root.thread_id,
                            'rootStatus', v_root.status);
end;
$$;

-- ===========================================================================
-- RPC 9 — reject_comment  [authenticated]
-- ===========================================================================
create or replace function public.reject_comment(p_comment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_root public.comments%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'EMPTY_REASON' using errcode = 'P0001';
  end if;
  select c.* into v_root from public.comments c
    join public.whiteboards w on w.whiteboard_id = c.whiteboard_id
   where c.comment_id = p_comment_id and w.owner_id = auth.uid()
   for update of c;
  if not found then
    raise exception 'COMMENT_NOT_FOUND_OR_FORBIDDEN: %', p_comment_id using errcode = 'P0001';
  end if;
  if v_root.parent_comment_id is not null then
    raise exception 'NOT_A_ROOT_COMMENT: %', p_comment_id using errcode = 'P0001';
  end if;

  -- Rationale and status change commit together; the deferred constraint
  -- trigger tg_comments_rejection_rationale validates at COMMIT.
  insert into public.comments
    (whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
     author_user_id, body, anchor_type, anchor_id, metadata_json)
  values
    (v_root.whiteboard_id, v_root.review_session_id, v_root.thread_id, v_root.comment_id, 'system',
     null, 'Rejected: ' || btrim(p_reason), v_root.anchor_type, v_root.anchor_id,
     jsonb_build_object('kind','rejection','reason', btrim(p_reason)));

  update public.comments set status = 'rejected' where comment_id = v_root.comment_id;
  return jsonb_build_object('commentId', v_root.comment_id, 'status', 'rejected');
end;
$$;

-- ===========================================================================
-- RPC 10 — apply_comment_patch  [authenticated]
-- ===========================================================================
create or replace function public.apply_comment_patch(
  p_comment_id uuid, p_expected_revision_no integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_root public.comments%rowtype; v_patch jsonb; v_result jsonb;
begin
  select c.* into v_root from public.comments c
    join public.whiteboards w on w.whiteboard_id = c.whiteboard_id
   where c.comment_id = p_comment_id and w.owner_id = auth.uid()
   for update of c;
  if not found then
    raise exception 'COMMENT_NOT_FOUND_OR_FORBIDDEN: %', p_comment_id using errcode = 'P0001';
  end if;
  v_patch := v_root.suggested_patch_json;
  if v_patch is null then
    raise exception 'NO_SUGGESTED_PATCH: %', p_comment_id using errcode = 'P0001';
  end if;

  -- Nested call: same transaction, board lock acquired inside.
  v_result := public.save_whiteboard_delta(
    v_root.whiteboard_id, p_expected_revision_no,
    coalesce(v_patch->'nodeUpserts', '[]'::jsonb),
    coalesce(array(select (x)::uuid from jsonb_array_elements_text(
      coalesce(v_patch->'nodeDeletes','[]'::jsonb)) x), '{}'::uuid[]),
    coalesce(v_patch->'edgeUpserts', '[]'::jsonb),
    coalesce(array(select (x)::uuid from jsonb_array_elements_text(
      coalesce(v_patch->'edgeDeletes','[]'::jsonb)) x), '{}'::uuid[]),
    null);

  insert into public.comments
    (whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
     author_user_id, body, anchor_type, anchor_id, metadata_json)
  values
    (v_root.whiteboard_id, v_root.review_session_id, v_root.thread_id, v_root.comment_id, 'system',
     null, 'Applied suggested patch at revision ' || (v_result->>'revisionNo'),
     v_root.anchor_type, v_root.anchor_id,
     jsonb_build_object('kind','graph_patch','patchVersion',1,
                        'appliedRevisionNo', (v_result->>'revisionNo')::integer));

  if v_root.status = 'open' then
    update public.comments set status = 'answered' where comment_id = v_root.comment_id;
  end if;

  return jsonb_build_object('revisionNo', (v_result->>'revisionNo')::integer,
                            'commentId', v_root.comment_id, 'rootStatus', 'answered');
end;
$$;

-- ===========================================================================
-- RPC 11 — record_explicit_assumption  [authenticated]
-- ===========================================================================
create or replace function public.record_explicit_assumption(
  p_root_comment_id uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_root public.comments%rowtype; v_prev uuid; v_new uuid;
begin
  if p_text is null or length(btrim(p_text)) = 0 then
    raise exception 'EMPTY_ASSUMPTION' using errcode = 'P0001';
  end if;
  select c.* into v_root from public.comments c
    join public.whiteboards w on w.whiteboard_id = c.whiteboard_id
   where c.comment_id = p_root_comment_id and w.owner_id = auth.uid()
   for update of c;
  if not found then
    raise exception 'COMMENT_NOT_FOUND_OR_FORBIDDEN: %', p_root_comment_id using errcode = 'P0001';
  end if;
  if v_root.parent_comment_id is not null then
    raise exception 'NOT_A_ROOT_COMMENT: %', p_root_comment_id using errcode = 'P0001';
  end if;

  select comment_id into v_prev from public.comments
   where thread_id = v_root.thread_id
     and metadata_json->>'kind' = 'assumption'
     and metadata_json->>'supersedesCommentId' is null
   limit 1 for update;

  if v_prev is not null then
    update public.comments
       set metadata_json = metadata_json || jsonb_build_object('supersededAt', now())
     where comment_id = v_prev;
  end if;

  insert into public.comments
    (whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
     author_user_id, body, anchor_type, anchor_id, metadata_json)
  values
    (v_root.whiteboard_id, v_root.review_session_id, v_root.thread_id, v_root.comment_id, 'system',
     null, btrim(p_text), v_root.anchor_type, v_root.anchor_id,
     jsonb_build_object('kind','assumption','assumptionText', btrim(p_text),
                        'sourceRootCommentId', v_root.comment_id::text,
                        'supersedesCommentId', v_prev))
  returning comment_id into v_new;

  if v_root.status = 'open' then
    update public.comments set status = 'answered' where comment_id = v_root.comment_id;
  end if;

  return jsonb_build_object('commentId', v_new, 'supersededCommentId', v_prev,
                            'rootStatus', 'answered');
end;
$$;

-- ===========================================================================
-- RPC 12 — record_policy_gap  [service_role only, A13, A14-hardened]
-- ===========================================================================
create or replace function public.record_policy_gap(
  p_actor_user_id      uuid,
  p_whiteboard_id      uuid,
  p_agent_version_id   uuid,
  p_eval_execution_id  uuid,
  p_failure_key        text,
  p_snapshot           jsonb,
  p_snapshot_hash      char(64),
  p_source_revision_no integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_board   public.whiteboards%rowtype;
  v_key     text;
  v_issue   text;
  v_round   smallint;
  v_sess    uuid;
  v_comment uuid;
  v_exists  uuid;
  v_ver_board uuid;
  v_exec_ver  uuid;
begin
  -- 1. Failure key normalized to the issue-key alphabet, never trusted raw.
  if p_failure_key is null then
    raise exception 'FAILURE_KEY_REQUIRED' using errcode = 'P0001';
  end if;
  v_key := lower(btrim(regexp_replace(p_failure_key, '[^A-Za-z0-9_]+', '_', 'g'), '_'));
  if v_key !~ '^[a-z0-9_]{3,80}$' then
    raise exception 'INVALID_FAILURE_KEY: %', p_failure_key using errcode = 'P0001';
  end if;
  v_issue := 'gap:' || v_key || ':canvas:canvas:-';

  if not meridian.is_sha256_hex(p_snapshot_hash) then
    raise exception 'INVALID_SNAPSHOT_HASH' using errcode = 'P0001';
  end if;

  -- 2. Board ownership, resolved from the explicit actor.
  v_board := meridian.lock_board_for_actor(p_actor_user_id, p_whiteboard_id);

  -- 3. The agent version must exist AND chain to this exact whiteboard
  --    through both the agent and the frozen spec.
  select av.whiteboard_id into v_ver_board
    from public.agent_versions av
    join public.agents a       on a.agent_id  = av.agent_id
    join public.frozen_specs f on f.spec_id   = av.spec_id
   where av.agent_version_id = p_agent_version_id
     and a.whiteboard_id     = av.whiteboard_id
     and f.whiteboard_id     = av.whiteboard_id;
  if v_ver_board is null then
    raise exception 'AGENT_VERSION_NOT_FOUND: %', p_agent_version_id using errcode = 'P0001';
  end if;
  if v_ver_board <> p_whiteboard_id then
    raise exception 'AGENT_VERSION_NOT_ON_WHITEBOARD: % is on %', p_agent_version_id, v_ver_board
      using errcode = 'P0001';
  end if;

  -- 4. The eval execution must belong to that exact agent version.
  select agent_version_id into v_exec_ver from public.executions
   where execution_id = p_eval_execution_id and run_type = 'eval';
  if v_exec_ver is null then
    raise exception 'EVAL_EXECUTION_NOT_FOUND: %', p_eval_execution_id using errcode = 'P0001';
  end if;
  if v_exec_ver <> p_agent_version_id then
    raise exception 'EVAL_EXECUTION_NOT_ON_VERSION: %', p_eval_execution_id using errcode = 'P0001';
  end if;

  -- 5 & 6. The board must still be at the supplied revision, and the snapshot
  --        must structurally match it (a trusted server assembled it).
  if v_board.revision_no <> p_source_revision_no then
    raise exception 'STALE_BOARD_REVISION: current=%', v_board.revision_no using errcode = 'P0001';
  end if;
  perform meridian.assert_snapshot_matches_board(p_whiteboard_id, v_board.revision_no, p_snapshot);

  -- 7. Duplicate gaps are idempotent: return the existing live root issue.
  select comment_id into v_exists from public.comments
   where whiteboard_id = p_whiteboard_id
     and parent_comment_id is null
     and issue_key = v_issue
     and status in ('open','answered');
  if v_exists is not null then
    return jsonb_build_object('commentId', v_exists, 'issueKey', v_issue,
                              'code', 'POLICY_GAP_ALREADY_RECORDED', 'wasExisting', true);
  end if;

  if exists (select 1 from public.review_sessions
              where whiteboard_id = p_whiteboard_id and status in ('queued','running')) then
    raise exception 'ACTIVE_REVIEW_EXISTS: %', p_whiteboard_id using errcode = 'P0001';
  end if;

  select coalesce(max(round_no), 0)::smallint + 1 into v_round
    from public.review_sessions where whiteboard_id = p_whiteboard_id;

  insert into public.review_sessions
    (whiteboard_id, round_no, source_revision_no, source_canvas_json, source_canvas_hash,
     status, requested_by, model_name, reasoning_effort, completed_at, review_summary_json)
  values
    (p_whiteboard_id, v_round, v_board.revision_no, p_snapshot, p_snapshot_hash,
     'completed', v_board.owner_id, 'eval-repair', 'n/a', now(),
     jsonb_build_object('origin','eval-repair','agentVersionId', p_agent_version_id))
  returning review_session_id into v_sess;

  v_comment := gen_random_uuid();
  insert into public.comments
    (comment_id, whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type,
     author_user_id, body, anchor_type, anchor_id, status, severity, issue_key, metadata_json)
  values
    (v_comment, p_whiteboard_id, v_sess, v_comment, null, 'system',
     null, 'Policy gap: the frozen specification does not define behaviour for "'
           || v_key || '". Eval repair stopped rather than inventing policy.',
     'canvas', null, 'open', 'blocking', v_issue,
     jsonb_build_object('kind','policy_gap','evalRunId', p_eval_execution_id::text,
                        'failureKey', v_key, 'agentVersionId', p_agent_version_id::text));

  return jsonb_build_object('reviewSessionId', v_sess, 'commentId', v_comment,
                            'issueKey', v_issue, 'wasExisting', false);
end;
$$;

-- ===========================================================================
-- RPC 13 — freeze_whiteboard_spec  [service_role only, A21, A26]
-- ===========================================================================
create or replace function public.freeze_whiteboard_spec(
  p_actor_user_id          uuid,
  p_whiteboard_id          uuid,
  p_expected_revision_no   integer,
  p_canvas_json            jsonb,
  p_canvas_hash            char(64),
  p_spec_json              jsonb,
  p_spec_hash              char(64),
  p_unresolved_comment_ids uuid[],
  p_ack_blockers           boolean,
  p_ack_stale_review       boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_board    public.whiteboards%rowtype;
  v_version  integer;
  v_spec_id  uuid;
  v_blockers integer;
  v_ids      uuid[] := coalesce(p_unresolved_comment_ids, '{}'::uuid[]);
begin
  if not meridian.is_sha256_hex(p_canvas_hash) or not meridian.is_sha256_hex(p_spec_hash) then
    raise exception 'INVALID_HASH_FORMAT' using errcode = 'P0001';
  end if;

  v_board := meridian.lock_board_for_actor(p_actor_user_id, p_whiteboard_id);
  if v_board.status = 'archived' then
    raise exception 'WHITEBOARD_ARCHIVED: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  if v_board.revision_no <> p_expected_revision_no then
    raise exception 'BOARD_CHANGED_DURING_FREEZE: current=%', v_board.revision_no using errcode = 'P0001';
  end if;
  perform meridian.assert_snapshot_matches_board(p_whiteboard_id, v_board.revision_no, p_canvas_json);

  -- [A26] Blockers are UNRESOLVED (open|answered) roots with blocking severity.
  -- Rejected roots are deliberately excluded.
  select count(*) into v_blockers from public.comments
   where whiteboard_id = p_whiteboard_id
     and meridian.is_unresolved_root(parent_comment_id, status)
     and severity = 'blocking';
  if v_blockers > 0 and not coalesce(p_ack_blockers, false) then
    raise exception 'UNRESOLVED_BLOCKERS: % blocking issue(s)', v_blockers using errcode = 'P0001';
  end if;

  -- [A18] Stale review warns; it does not require a new review.
  if v_board.last_reviewed_revision_no is distinct from v_board.revision_no
     and not coalesce(p_ack_stale_review, false) then
    raise exception 'STALE_REVIEW: lastReviewed=% current=%',
      coalesce(v_board.last_reviewed_revision_no, 0), v_board.revision_no using errcode = 'P0001';
  end if;

  select coalesce(max(spec_version), 0) + 1 into v_version
    from public.frozen_specs where whiteboard_id = p_whiteboard_id;

  -- The artifact is compiled before the row exists, so spec_json already carries the identity the
  -- compiler hashed. Adopting it as the primary key is what makes
  -- spec_json.identity.specId = frozen_specs.spec_id an invariant rather than a convention.
  begin
    v_spec_id := (p_spec_json->'identity'->>'specId')::uuid;
  exception when others then
    raise exception 'INVALID_SPEC_IDENTITY: identity.specId must be a uuid' using errcode = 'P0001';
  end;
  if v_spec_id is null then
    raise exception 'INVALID_SPEC_IDENTITY: identity.specId is required' using errcode = 'P0001';
  end if;
  if (p_spec_json->'identity'->>'whiteboardId')::uuid is distinct from p_whiteboard_id then
    raise exception 'INVALID_SPEC_IDENTITY: identity.whiteboardId mismatch' using errcode = 'P0001';
  end if;
  if (p_spec_json->'identity'->>'specVersion')::integer is distinct from v_version then
    raise exception 'BOARD_CHANGED_DURING_FREEZE: specVersion=%', v_version using errcode = 'P0001';
  end if;

  insert into public.frozen_specs
    (spec_id, whiteboard_id, spec_version, source_revision_no, source_canvas_hash,
     source_canvas_json, spec_json, spec_hash, unresolved_comment_ids, created_by)
  values
    (v_spec_id, p_whiteboard_id, v_version, v_board.revision_no, p_canvas_hash,
     p_canvas_json, p_spec_json, p_spec_hash, v_ids, p_actor_user_id);

  update public.whiteboards set status = 'submitted' where whiteboard_id = p_whiteboard_id;

  return jsonb_build_object(
    'specId', v_spec_id, 'specVersion', v_version, 'specHash', p_spec_hash,
    'sourceCanvasHash', p_canvas_hash, 'sourceRevisionNo', v_board.revision_no,
    'unresolvedCommentIds', to_jsonb(v_ids),
    'blockerCount', v_blockers,
    'acknowledgedStaleReview', coalesce(p_ack_stale_review, false));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges. [A21] The six trusted-artifact functions are service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.create_review_session(uuid, uuid, integer, jsonb, char, text, text)
  from public, anon, authenticated;
grant  execute on function public.create_review_session(uuid, uuid, integer, jsonb, char, text, text)
  to service_role;

revoke all on function public.finalize_review_session(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant  execute on function public.finalize_review_session(uuid, uuid, jsonb, jsonb) to service_role;

revoke all on function public.fail_review_session(uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.fail_review_session(uuid, uuid, jsonb) to service_role;

revoke all on function public.reply_to_comment(uuid, text) from public, anon;
grant  execute on function public.reply_to_comment(uuid, text) to authenticated;

revoke all on function public.reject_comment(uuid, text) from public, anon;
grant  execute on function public.reject_comment(uuid, text) to authenticated;

revoke all on function public.apply_comment_patch(uuid, integer) from public, anon;
grant  execute on function public.apply_comment_patch(uuid, integer) to authenticated;

revoke all on function public.record_explicit_assumption(uuid, text) from public, anon;
grant  execute on function public.record_explicit_assumption(uuid, text) to authenticated;

revoke all on function public.record_policy_gap(uuid, uuid, uuid, uuid, text, jsonb, char, integer)
  from public, anon, authenticated;
grant  execute on function public.record_policy_gap(uuid, uuid, uuid, uuid, text, jsonb, char, integer)
  to service_role;

revoke all on function public.freeze_whiteboard_spec(
  uuid, uuid, integer, jsonb, char, jsonb, char, uuid[], boolean, boolean)
  from public, anon, authenticated;
grant  execute on function public.freeze_whiteboard_spec(
  uuid, uuid, integer, jsonb, char, jsonb, char, uuid[], boolean, boolean) to service_role;

revoke all on function meridian.is_unresolved_root(uuid, text) from public, anon;
revoke all on function meridian.root_has_live_assumption(uuid) from public, anon;
revoke all on function meridian.assert_snapshot_matches_board(uuid, integer, jsonb)
  from public, anon, authenticated;
revoke all on function meridian.lock_board_for_actor(uuid, uuid) from public, anon, authenticated;
