-- Generic transition validator.
create or replace function meridian.assert_transition(p_table text, p_old text, p_new text, p_allowed text[])
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_old is distinct from p_new and not ((p_old || '->' || p_new) = any(p_allowed)) then
    raise exception 'ILLEGAL_TRANSITION: %.% -> %', p_table, p_old, p_new using errcode = 'P0001';
  end if;
end;
$$;

create or replace function meridian.tg_whiteboard_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- [A18] `draft->submitted` is allowed on purpose. A board edited after its last review returns
  -- to `draft`, and a stale review only warns, so refusing that transition here would quietly
  -- reinstate the "you must review again before freezing" rule that A18 removed. Whether the
  -- freeze is wise remains freeze_whiteboard_spec's judgement, made with acknowledgements in hand.
  perform meridian.assert_transition('whiteboards', old.status, new.status, array[
    'draft->review_ready','review_ready->draft','review_ready->submitted','submitted->draft',
    'draft->submitted',
    'draft->archived','review_ready->archived','submitted->archived','archived->draft']);
  if new.revision_no < old.revision_no then
    raise exception 'REVISION_MUST_NOT_DECREASE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_whiteboards_lifecycle before update on public.whiteboards
  for each row execute function meridian.tg_whiteboard_status();

create or replace function meridian.tg_review_session_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_transition('review_sessions', old.status, new.status, array[
    'queued->running','running->completed','running->failed','queued->failed']);
  return new;
end;
$$;
create trigger tg_review_sessions_lifecycle before update on public.review_sessions
  for each row execute function meridian.tg_review_session_status();

create or replace function meridian.tg_comment_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.parent_comment_id is not null then
    return new;  -- replies have no status
  end if;
  perform meridian.assert_transition('comments', old.status, new.status, array[
    'open->answered','open->rejected','answered->rejected','open->resolved','answered->resolved',
    'rejected->open','resolved->open']);
  if old.status = 'answered' and new.status = 'resolved' and not meridian.in_review_finalize() then
    raise exception 'RESOLUTION_REQUIRES_REVIEW_RECONCILIATION' using errcode = 'P0001';
  end if;
  if new.issue_key is distinct from old.issue_key or new.thread_id <> old.thread_id
     or new.review_session_id <> old.review_session_id then
    raise exception 'COMMENT_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_comments_lifecycle before update on public.comments
  for each row execute function meridian.tg_comment_status();

-- Root comment anchors must exist in the reviewed SNAPSHOT, not the live board.
create or replace function meridian.check_comment_anchor()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_snapshot jsonb; v_found boolean;
begin
  if new.parent_comment_id is not null or new.anchor_type = 'canvas' then
    return new;
  end if;
  select source_canvas_json into v_snapshot from public.review_sessions
   where review_session_id = new.review_session_id;
  if new.anchor_type = 'node' then
    select exists (select 1 from jsonb_array_elements(v_snapshot->'nodes') n
                    where (n->>'nodeId')::uuid = new.anchor_id) into v_found;
  else
    select exists (select 1 from jsonb_array_elements(v_snapshot->'edges') e
                    where (e->>'edgeId')::uuid = new.anchor_id) into v_found;
  end if;
  if not v_found then
    raise exception 'ANCHOR_NOT_IN_REVIEWED_SNAPSHOT: % %', new.anchor_type, new.anchor_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_comments_anchor before insert on public.comments
  for each row execute function meridian.check_comment_anchor();

-- A rejected root must retain a rejection rationale reply (deferred to end of transaction).
create or replace function meridian.check_rejection_rationale()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'rejected' and not exists (
      select 1 from public.comments r
       where r.thread_id = new.thread_id
         and r.parent_comment_id is not null
         and r.metadata_json->>'kind' = 'rejection') then
    raise exception 'REJECTION_RATIONALE_REQUIRED: %', new.comment_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create constraint trigger tg_comments_rejection_rationale
  after insert or update of status on public.comments
  deferrable initially deferred
  for each row execute function meridian.check_rejection_rationale();

-- Assumption supersession must stay inside the same thread.
create or replace function meridian.check_assumption_supersede()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_prev public.comments%rowtype;
begin
  if new.metadata_json->>'kind' <> 'assumption'
     or new.metadata_json->>'supersedesCommentId' is null then
    return new;
  end if;
  select * into v_prev from public.comments
   where comment_id = (new.metadata_json->>'supersedesCommentId')::uuid;
  if not found or v_prev.thread_id <> new.thread_id
     or v_prev.metadata_json->>'kind' <> 'assumption' then
    raise exception 'INVALID_ASSUMPTION_SUPERSESSION' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_comments_assumption_supersede before insert on public.comments
  for each row execute function meridian.check_assumption_supersede();

-- [A7] code_path must match the owning agent and zero-padded version.
create or replace function meridian.check_agent_version_code_path()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_key text; v_expected text;
begin
  select deployment_key into v_key from public.agents where agent_id = new.agent_id;
  v_expected := 'generated-agents/' || v_key || '/v' || lpad(new.version_no::text, 3, '0');
  if new.code_path <> v_expected then
    raise exception 'CODE_PATH_MISMATCH: expected %, got %', v_expected, new.code_path
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_agent_versions_code_path before insert or update on public.agent_versions
  for each row execute function meridian.check_agent_version_code_path();

-- Parent version must be strictly lower.
create or replace function meridian.check_agent_version_parent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_parent_no integer;
begin
  if new.parent_agent_version_id is null then return new; end if;
  select version_no into v_parent_no from public.agent_versions
   where agent_version_id = new.parent_agent_version_id;
  if v_parent_no is null or v_parent_no >= new.version_no then
    raise exception 'PARENT_VERSION_NOT_LOWER' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_agent_versions_parent before insert or update on public.agent_versions
  for each row execute function meridian.check_agent_version_parent();

-- [A5] Git commit + manifest gate and version lifecycle.
create or replace function meridian.check_agent_version_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_spec_hash char(64);
begin
  if tg_op = 'UPDATE' then
    perform meridian.assert_transition('agent_versions', old.status, new.status, array[
      'generated->evaluating','evaluating->approved','evaluating->failed','failed->evaluating']);
    if old.status <> 'generated' and (
         new.git_commit_sha is distinct from old.git_commit_sha
      or new.spec_id       is distinct from old.spec_id
      or new.agent_id      is distinct from old.agent_id
      or new.version_no    is distinct from old.version_no
      or new.code_path     is distinct from old.code_path
      or (new.build_manifest_json->>'specHash') is distinct from (old.build_manifest_json->>'specHash')) then
      raise exception 'AGENT_VERSION_LINEAGE_FROZEN' using errcode = 'P0001';
    end if;
  end if;

  if new.status in ('evaluating','approved') then
    if new.git_commit_sha is null or not meridian.is_git_sha1(new.git_commit_sha) then
      raise exception 'GIT_COMMIT_REQUIRED' using errcode = 'P0001';
    end if;
    select spec_hash into v_spec_hash from public.frozen_specs where spec_id = new.spec_id;
    if new.build_manifest_json->>'specHash' is distinct from v_spec_hash then
      raise exception 'MANIFEST_SPEC_HASH_MISMATCH' using errcode = 'P0001';
    end if;
    if not meridian.is_json_array(new.build_manifest_json->'generatedFiles')
       or jsonb_array_length(new.build_manifest_json->'generatedFiles') = 0 then
      raise exception 'MANIFEST_GENERATED_FILES_REQUIRED' using errcode = 'P0001';
    end if;
    if not (new.build_manifest_json ? 'validation') then
      raise exception 'MANIFEST_VALIDATION_REQUIRED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger tg_agent_versions_gate before insert or update on public.agent_versions
  for each row execute function meridian.check_agent_version_gate();

-- [A5] Execution lineage + live-run gating.
create or replace function meridian.check_execution_lineage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v public.agent_versions%rowtype; v_agent public.agents%rowtype;
begin
  select * into v from public.agent_versions where agent_version_id = new.agent_version_id;
  if v.git_commit_sha is null then
    raise exception 'EXECUTION_REQUIRES_COMMITTED_VERSION' using errcode = 'P0001';
  end if;
  if new.run_type = 'live' then
    if v.status <> 'approved' then
      raise exception 'LIVE_RUN_REQUIRES_APPROVED_VERSION' using errcode = 'P0001';
    end if;
    select * into v_agent from public.agents where agent_id = new.agent_id;
    if v_agent.status <> 'active' then
      raise exception 'AGENT_NOT_ACTIVE' using errcode = 'P0001';
    end if;
    if v_agent.active_agent_version_id is distinct from new.agent_version_id then
      raise exception 'VERSION_NOT_ACTIVE_RELEASE' using errcode = 'P0001';
    end if;
  else
    if v.status not in ('evaluating','approved','failed') then
      raise exception 'EVAL_RUN_REQUIRES_EVALUATING_VERSION' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger tg_executions_lineage before insert on public.executions
  for each row execute function meridian.check_execution_lineage();

create or replace function meridian.tg_execution_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_transition('executions', old.status, new.status, array[
    'queued->running','running->passed','running->failed','running->error','queued->error']);
  if new.run_type <> old.run_type
     or new.agent_version_id <> old.agent_version_id
     or new.agent_id <> old.agent_id
     or new.idempotency_key <> old.idempotency_key then
    raise exception 'EXECUTION_LINEAGE_IMMUTABLE' using errcode = 'P0001';
  end if;
  -- [A24] The workflow id may be filled in once (it is normally set at insert),
  -- but never changed to a different value.
  if old.temporal_workflow_id is not null
     and new.temporal_workflow_id is distinct from old.temporal_workflow_id then
    raise exception 'WORKFLOW_ID_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_executions_lifecycle before update on public.executions
  for each row execute function meridian.tg_execution_status();

create or replace function meridian.tg_execution_step_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_transition('execution_steps', old.status, new.status, array[
    'queued->running','queued->skipped','running->succeeded','running->failed']);
  if new.execution_id <> old.execution_id
     or new.step_instance_key <> old.step_instance_key
     or new.attempt_no <> old.attempt_no
     or new.step_key <> old.step_key then
    raise exception 'STEP_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_execution_steps_lifecycle before update on public.execution_steps
  for each row execute function meridian.tg_execution_step_status();

-- [A22] The COMPLETE and only permitted action transition set.
-- 'dispatched->reserved' is deliberately ABSENT: returning a dispatched action
-- to reserved would permit a blind resend of something that may already have
-- reached the provider. The only route back to 'reserved' is
-- 'needs_reconciliation->reserved', which reconcile_execution_action performs
-- exclusively when reconciliation positively proved non-delivery.
create or replace function meridian.tg_execution_action_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_transition('execution_actions', old.status, new.status, array[
    'reserved->dispatched',
    'reserved->abandoned',
    'dispatched->succeeded',
    'dispatched->failed',
    'dispatched->needs_reconciliation',
    'needs_reconciliation->reserved',
    'needs_reconciliation->succeeded',
    'needs_reconciliation->abandoned']);

  if new.idempotency_key <> old.idempotency_key
     or new.execution_id  <> old.execution_id
     or new.action_type   <> old.action_type
     or new.marker_token  <> old.marker_token then
    raise exception 'ACTION_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;

  -- attempt_count never decreases.
  if new.attempt_count < old.attempt_count then
    raise exception 'ACTION_ATTEMPT_COUNT_MUST_NOT_DECREASE' using errcode = 'P0001';
  end if;

  -- A provider identifier, once recorded, is immutable.
  if old.provider_action_id is not null
     and new.provider_action_id is distinct from old.provider_action_id then
    raise exception 'PROVIDER_ACTION_ID_IMMUTABLE' using errcode = 'P0001';
  end if;

  -- Returning to 'reserved' requires recorded reconciliation evidence and
  -- clears the dispatch marker so the next attempt starts cleanly.
  if new.status = 'reserved' then
    if new.reconciliation_json is null then
      raise exception 'RECONCILIATION_EVIDENCE_REQUIRED' using errcode = 'P0001';
    end if;
    if new.dispatched_at is not null then
      raise exception 'RESERVED_MUST_CLEAR_DISPATCHED_AT' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
create trigger tg_execution_actions_lifecycle before update on public.execution_actions
  for each row execute function meridian.tg_execution_action_status();

create or replace function meridian.tg_agent_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_transition('agents', old.status, new.status, array[
    'draft->active','active->paused','paused->active',
    'draft->archived','active->archived','paused->archived']);
  if old.status = 'archived' and new.status <> 'archived' then
    raise exception 'AGENT_ARCHIVE_IS_TERMINAL' using errcode = 'P0001';
  end if;
  if new.whiteboard_id <> old.whiteboard_id or new.deployment_key <> old.deployment_key then
    raise exception 'AGENT_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_agents_lifecycle before update on public.agents
  for each row execute function meridian.tg_agent_status();
