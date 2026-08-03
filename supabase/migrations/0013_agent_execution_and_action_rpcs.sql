-- ===========================================================================
-- RPC 14 — create_agent  [authenticated]
-- ===========================================================================
create or replace function public.create_agent(
  p_whiteboard_id uuid, p_deployment_key text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_key text;
begin
  perform meridian.assert_board_owner(p_whiteboard_id);
  v_key := lower(btrim(coalesce(p_deployment_key, '')));
  if v_key !~ '^[a-z][a-z0-9-]{2,63}$' then
    raise exception 'INVALID_DEPLOYMENT_KEY: %', p_deployment_key using errcode = 'P0001';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'INVALID_AGENT_NAME' using errcode = 'P0001';
  end if;
  begin
    insert into public.agents (whiteboard_id, deployment_key, name, status, active_agent_version_id)
    values (p_whiteboard_id, v_key, btrim(p_name), 'draft', null)
    returning agent_id into v_id;
  exception when unique_violation then
    raise exception 'DEPLOYMENT_KEY_TAKEN: %', v_key using errcode = 'P0001';
  end;
  return jsonb_build_object('agentId', v_id, 'deploymentKey', v_key, 'status', 'draft');
end;
$$;

-- ===========================================================================
-- RPC 15 — create_agent_version  [authenticated, service_role]
-- ===========================================================================
create or replace function public.create_agent_version(
  p_agent_id uuid, p_spec_id uuid, p_parent_agent_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_agent public.agents%rowtype;
  v_spec  public.frozen_specs%rowtype;
  v_no    integer;
  v_path  text;
  v_id    uuid;
begin
  select a.* into v_agent from public.agents a
    join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
   where a.agent_id = p_agent_id
     and (w.owner_id = auth.uid() or auth.uid() is null)   -- service_role has no uid
   for update of a;
  if not found then
    raise exception 'AGENT_NOT_FOUND_OR_FORBIDDEN: %', p_agent_id using errcode = 'P0001';
  end if;
  if v_agent.status = 'archived' then
    raise exception 'AGENT_ARCHIVED: %', p_agent_id using errcode = 'P0001';
  end if;

  select * into v_spec from public.frozen_specs where spec_id = p_spec_id;
  if not found or v_spec.whiteboard_id <> v_agent.whiteboard_id then
    raise exception 'SPEC_NOT_ON_AGENT_WHITEBOARD: %', p_spec_id using errcode = 'P0001';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_no
    from public.agent_versions where agent_id = p_agent_id;
  v_path := 'generated-agents/' || v_agent.deployment_key || '/v' || lpad(v_no::text, 3, '0');

  insert into public.agent_versions
    (agent_id, whiteboard_id, spec_id, version_no, parent_agent_version_id, status,
     code_path, git_commit_sha, build_manifest_json)
  values
    (p_agent_id, v_agent.whiteboard_id, p_spec_id, v_no, p_parent_agent_version_id, 'generated',
     v_path, null, jsonb_build_object('state','reserved','specHash', v_spec.spec_hash))
  returning agent_version_id into v_id;

  return jsonb_build_object('agentVersionId', v_id, 'versionNo', v_no,
                            'codePath', v_path, 'specHash', v_spec.spec_hash);
end;
$$;

-- ===========================================================================
-- RPC 16 — record_agent_commit  [service_role only, A21]
-- ===========================================================================
create or replace function public.record_agent_commit(
  p_actor_user_id     uuid,
  p_agent_version_id  uuid,
  p_git_commit_sha    text,
  p_build_manifest    jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ver public.agent_versions%rowtype; v_spec_hash char(64); v_owner uuid;
begin
  if not meridian.is_git_sha1(p_git_commit_sha) then
    raise exception 'INVALID_GIT_SHA: %', p_git_commit_sha using errcode = 'P0001';
  end if;
  select av.* into v_ver from public.agent_versions av
   where av.agent_version_id = p_agent_version_id for update;
  if not found then
    raise exception 'AGENT_VERSION_NOT_FOUND: %', p_agent_version_id using errcode = 'P0001';
  end if;

  -- Ownership re-check against the EXPLICIT actor (service role has no uid).
  select w.owner_id into v_owner from public.whiteboards w
   where w.whiteboard_id = v_ver.whiteboard_id;
  if v_owner is distinct from p_actor_user_id then
    raise exception 'AGENT_VERSION_NOT_FOUND: %', p_agent_version_id using errcode = 'P0001';
  end if;

  if v_ver.status <> 'generated' then
    raise exception 'VERSION_NOT_GENERATED: %', v_ver.status using errcode = 'P0001';
  end if;
  select spec_hash into v_spec_hash from public.frozen_specs where spec_id = v_ver.spec_id;
  if p_build_manifest->>'specHash' is distinct from v_spec_hash then
    raise exception 'MANIFEST_SPEC_HASH_MISMATCH' using errcode = 'P0001';
  end if;

  update public.agent_versions
     set git_commit_sha = p_git_commit_sha, build_manifest_json = p_build_manifest
   where agent_version_id = p_agent_version_id;

  return jsonb_build_object('agentVersionId', p_agent_version_id,
                            'gitCommitSha', p_git_commit_sha, 'specHash', v_spec_hash);
end;
$$;

-- ===========================================================================
-- RPC 17 — transition_agent_version  [authenticated, service_role]
-- ===========================================================================
create or replace function public.transition_agent_version(
  p_agent_version_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ver public.agent_versions%rowtype;
begin
  if p_status not in ('evaluating','approved','failed') then
    raise exception 'STATUS_NOT_TRANSITIONABLE: %', p_status using errcode = 'P0001';
  end if;
  select av.* into v_ver from public.agent_versions av
    join public.whiteboards w on w.whiteboard_id = av.whiteboard_id
   where av.agent_version_id = p_agent_version_id
     and (w.owner_id = auth.uid() or auth.uid() is null)
   for update of av;
  if not found then
    raise exception 'AGENT_VERSION_NOT_FOUND: %', p_agent_version_id using errcode = 'P0001';
  end if;

  -- The gate trigger enforces SHA + manifest requirements and legal edges.
  -- active_agent_version_id is NEVER touched here (A17).
  update public.agent_versions
     set status = p_status,
         approved_at = case when p_status = 'approved' then now() else approved_at end
   where agent_version_id = p_agent_version_id;

  return jsonb_build_object('agentVersionId', p_agent_version_id, 'status', p_status,
                            'approvedAt', case when p_status = 'approved' then now() else null end);
end;
$$;

-- ===========================================================================
-- RPC 18 — activate_agent_version  [authenticated, A17]
-- ===========================================================================
create or replace function public.activate_agent_version(
  p_agent_id uuid, p_agent_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent public.agents%rowtype; v_prev uuid; v_status text;
begin
  select a.* into v_agent from public.agents a
    join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
   where a.agent_id = p_agent_id and w.owner_id = auth.uid()
   for update of a;
  if not found then
    raise exception 'AGENT_NOT_FOUND_OR_FORBIDDEN: %', p_agent_id using errcode = 'P0001';
  end if;
  if v_agent.status = 'archived' then
    raise exception 'AGENT_ARCHIVED: %', p_agent_id using errcode = 'P0001';
  end if;

  select status into v_status from public.agent_versions
   where agent_version_id = p_agent_version_id and agent_id = p_agent_id;
  if v_status is null then
    raise exception 'VERSION_NOT_ON_AGENT: %', p_agent_version_id using errcode = 'P0001';
  end if;
  if v_status <> 'approved' then
    raise exception 'ACTIVE_VERSION_NOT_APPROVED: %', v_status using errcode = 'P0001';
  end if;

  v_prev := v_agent.active_agent_version_id;
  update public.agents
     set active_agent_version_id = p_agent_version_id,
         status = case when status in ('draft','paused') then 'active' else status end
   where agent_id = p_agent_id;

  return jsonb_build_object('agentId', p_agent_id,
                            'activeAgentVersionId', p_agent_version_id,
                            'previousActiveAgentVersionId', v_prev,
                            'status', 'active');
end;
$$;

-- ===========================================================================
-- RPC 19 — create_execution  [service_role only]
-- ===========================================================================
create or replace function public.create_execution(
  p_agent_id             uuid,
  p_agent_version_id     uuid,
  p_run_type             text,
  p_case_key             text,
  p_business_key         text,
  p_temporal_workflow_id text,
  p_idempotency_key      char(64),
  p_input_ref            jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text; v_wf text;
begin
  if not meridian.is_sha256_hex(p_idempotency_key) then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;
  if p_run_type not in ('eval','live') then
    raise exception 'INVALID_RUN_TYPE: %', p_run_type using errcode = 'P0001';
  end if;

  -- `on conflict` names one arbiter index, but the row is checked against every unique index on
  -- the table. Two callers inserting the same idempotency key concurrently also collide on
  -- `uq_executions_active_workflow`, and a collision on a non-arbiter index raises rather than
  -- resolving -- so the handler below re-reads instead of letting the race surface as an error.
  begin
    insert into public.executions
      (agent_id, agent_version_id, run_type, case_key, business_key,
       temporal_workflow_id, idempotency_key, status, input_ref_json)
    values
      (p_agent_id, p_agent_version_id, p_run_type, p_case_key, p_business_key,
       p_temporal_workflow_id, p_idempotency_key, 'queued', coalesce(p_input_ref,'{}'::jsonb))
    on conflict (idempotency_key) do nothing
    returning execution_id, status, temporal_workflow_id into v_id, v_status, v_wf;
  exception when unique_violation then
    select execution_id, status, temporal_workflow_id into v_id, v_status, v_wf
      from public.executions where idempotency_key = p_idempotency_key;
    -- Nothing under this key: the refusal was the active-workflow index telling a *different*
    -- case that this workflow already has a live run. That is the constraint doing its job, and
    -- it is re-raised rather than swallowed.
    if v_id is null then
      raise;
    end if;
    return jsonb_build_object('executionId', v_id, 'wasExisting', true,
                              'status', v_status, 'temporalWorkflowId', v_wf);
  end;

  if v_id is null then
    select execution_id, status, temporal_workflow_id into v_id, v_status, v_wf
      from public.executions where idempotency_key = p_idempotency_key;
    return jsonb_build_object('executionId', v_id, 'wasExisting', true,
                              'status', v_status, 'temporalWorkflowId', v_wf);
  end if;

  insert into public.execution_events (execution_id, event_type, event_key, payload_json)
  values (v_id, 'state_transition', 'execution:created',
          jsonb_build_object('to','queued','runType',p_run_type,'businessKey',p_business_key));

  return jsonb_build_object('executionId', v_id, 'wasExisting', false,
                            'status', 'queued', 'temporalWorkflowId', v_wf);
end;
$$;

-- ===========================================================================
-- RPC 20 — start_execution  [service_role only, A23, A24]
-- ===========================================================================
create or replace function public.start_execution(
  p_execution_id         uuid,
  p_temporal_workflow_id text,
  p_temporal_run_id      text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_exec public.executions%rowtype;
begin
  select * into v_exec from public.executions where execution_id = p_execution_id for update;
  if not found then
    raise exception 'EXECUTION_NOT_FOUND: %', p_execution_id using errcode = 'P0001';
  end if;

  -- Idempotent: a row that already left 'queued' is returned unchanged, which
  -- is what makes the intake reconciliation sweeper safe to replay (A24 step 8).
  if v_exec.status <> 'queued' then
    return jsonb_build_object('executionId', p_execution_id, 'status', v_exec.status,
                              'temporalWorkflowId', v_exec.temporal_workflow_id,
                              'temporalRunId', v_exec.temporal_run_id, 'wasAlreadyStarted', true);
  end if;

  update public.executions
     set status               = 'running',
         started_at           = now(),
         temporal_workflow_id = coalesce(temporal_workflow_id, p_temporal_workflow_id),
         temporal_run_id      = coalesce(p_temporal_run_id, temporal_run_id)
   where execution_id = p_execution_id;

  insert into public.execution_events (execution_id, event_type, event_key, payload_json)
  values (p_execution_id, 'state_transition', 'execution:running',
          jsonb_build_object('from','queued','to','running',
                             'workflowId', p_temporal_workflow_id, 'runId', p_temporal_run_id));

  return jsonb_build_object('executionId', p_execution_id, 'status', 'running',
                            'temporalWorkflowId', coalesce(v_exec.temporal_workflow_id, p_temporal_workflow_id),
                            'temporalRunId', p_temporal_run_id, 'wasAlreadyStarted', false);
end;
$$;

-- ===========================================================================
-- RPC 21 — complete_execution  [service_role only, A23]
-- ===========================================================================
create or replace function public.complete_execution(
  p_execution_id     uuid,
  p_status           text,
  p_output_summary   jsonb,
  p_diff_summary     jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_exec public.executions%rowtype;
begin
  if p_status not in ('passed','failed') then
    raise exception 'INVALID_TERMINAL_STATUS: % (use fail_execution for error)', p_status
      using errcode = 'P0001';
  end if;
  select * into v_exec from public.executions where execution_id = p_execution_id for update;
  if not found then
    raise exception 'EXECUTION_NOT_FOUND: %', p_execution_id using errcode = 'P0001';
  end if;
  if v_exec.status = p_status then
    return jsonb_build_object('executionId', p_execution_id, 'status', p_status,
                              'wasAlreadyTerminal', true);
  end if;

  update public.executions
     set status = p_status, completed_at = now(),
         output_summary_json = coalesce(p_output_summary, output_summary_json),
         diff_summary_json   = coalesce(p_diff_summary,   diff_summary_json)
   where execution_id = p_execution_id;

  insert into public.execution_events (execution_id, event_type, event_key, payload_json)
  values (p_execution_id, 'state_transition', 'execution:' || p_status,
          jsonb_build_object('from', v_exec.status, 'to', p_status));

  return jsonb_build_object('executionId', p_execution_id, 'status', p_status,
                            'wasAlreadyTerminal', false);
end;
$$;

-- ===========================================================================
-- RPC 22 — fail_execution  [service_role only, A23]
-- ===========================================================================
create or replace function public.fail_execution(p_execution_id uuid, p_error jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_exec public.executions%rowtype;
begin
  select * into v_exec from public.executions where execution_id = p_execution_id for update;
  if not found then
    raise exception 'EXECUTION_NOT_FOUND: %', p_execution_id using errcode = 'P0001';
  end if;
  if v_exec.status = 'error' then
    return jsonb_build_object('executionId', p_execution_id, 'status', 'error',
                              'wasAlreadyTerminal', true);
  end if;

  update public.executions
     set status = 'error', completed_at = now(),
         error_json = coalesce(p_error, jsonb_build_object('code','UNKNOWN'))
   where execution_id = p_execution_id;

  insert into public.execution_events (execution_id, event_type, event_key, payload_json)
  values (p_execution_id, 'state_transition', 'execution:error',
          jsonb_build_object('from', v_exec.status, 'to', 'error',
                             'error', coalesce(p_error, jsonb_build_object('code','UNKNOWN'))));

  return jsonb_build_object('executionId', p_execution_id, 'status', 'error',
                            'wasAlreadyTerminal', false);
end;
$$;

-- ===========================================================================
-- RPC 23 — create_manual_review_intake_execution  [service_role only, A23]
-- The complete no-business-key / conflicting-key path, in ONE transaction.
-- ===========================================================================
create or replace function public.create_manual_review_intake_execution(
  p_agent_id         uuid,
  p_agent_version_id uuid,
  p_case_key         text,
  p_idempotency_key  char(64),
  p_reason           text,
  p_candidates       jsonb,
  p_input_ref        jsonb,
  p_message_ref      jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_existing uuid;
begin
  if not meridian.is_sha256_hex(p_idempotency_key) then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;
  if p_reason not in ('NO_BUSINESS_KEY','CONFLICTING_BUSINESS_KEYS') then
    raise exception 'INVALID_MANUAL_REVIEW_REASON: %', p_reason using errcode = 'P0001';
  end if;

  insert into public.executions
    (agent_id, agent_version_id, run_type, case_key,
     business_key, temporal_workflow_id, temporal_run_id, idempotency_key,
     status, input_ref_json, output_summary_json, started_at, completed_at)
  values
    (p_agent_id, p_agent_version_id, 'live', p_case_key,
     null,                              -- no business key by definition
     null, null,                        -- [A23] no Temporal workflow is started
     p_idempotency_key,
     'passed',                          -- the run completed; the OUTCOME is manual_review
     coalesce(p_input_ref, '{}'::jsonb),
     jsonb_build_object('outcome','manual_review','reason', p_reason,
                        'candidates', coalesce(p_candidates, '[]'::jsonb)),
     now(), now())
  on conflict (idempotency_key) do nothing
  returning execution_id into v_id;

  if v_id is null then
    select execution_id into v_existing from public.executions
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('executionId', v_existing, 'wasExisting', true,
                              'outcome', 'manual_review', 'reason', p_reason);
  end if;

  insert into public.execution_events (execution_id, event_type, event_key, payload_json)
  values
    (v_id, 'evidence', 'message:' || coalesce(p_message_ref->>'providerMessageId','unknown'),
     coalesce(p_message_ref, '{}'::jsonb)),
    (v_id, 'state_transition', 'execution:manual_review',
     jsonb_build_object('to','passed','outcome','manual_review','reason', p_reason,
                        'candidates', coalesce(p_candidates, '[]'::jsonb)));

  return jsonb_build_object('executionId', v_id, 'wasExisting', false,
                            'outcome', 'manual_review', 'reason', p_reason);
end;
$$;

-- ===========================================================================
-- RPC 24 — reserve_execution_action  [service_role only, A16]
-- ===========================================================================
create or replace function public.reserve_execution_action(
  p_execution_id      uuid,
  p_step_execution_id uuid,
  p_action_type       text,
  p_request_payload   jsonb,
  p_idempotency_key   char(64)
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  if not meridian.is_sha256_hex(p_idempotency_key) then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;
  if p_action_type not in ('mail.send','mail.draft','mail.reply','browser.write','human.handoff') then
    raise exception 'INVALID_ACTION_TYPE: %', p_action_type using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.executions where execution_id = p_execution_id) then
    raise exception 'EXECUTION_NOT_FOUND: %', p_execution_id using errcode = 'P0001';
  end if;

  insert into public.execution_actions
    (execution_id, step_execution_id, action_type, idempotency_key, marker_token,
     status, request_payload_json)
  values
    (p_execution_id, p_step_execution_id, p_action_type, p_idempotency_key,
     left(p_idempotency_key, 12), 'reserved', coalesce(p_request_payload, '{}'::jsonb))
  on conflict (idempotency_key) do nothing
  returning * into v_a;

  if v_a.execution_action_id is null then
    select * into v_a from public.execution_actions
     where idempotency_key = p_idempotency_key for update;
    return jsonb_build_object('executionActionId', v_a.execution_action_id,
      'status', v_a.status, 'markerToken', v_a.marker_token,
      'providerActionId', v_a.provider_action_id, 'attemptCount', v_a.attempt_count,
      'wasExisting', true);
  end if;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (p_execution_id, p_step_execution_id, v_a.execution_action_id, 'action',
     'action:reserved:' || v_a.marker_token,
     jsonb_build_object('phase','reserved','actionType',p_action_type,
                        'markerToken', v_a.marker_token));

  return jsonb_build_object('executionActionId', v_a.execution_action_id,
    'status', 'reserved', 'markerToken', v_a.marker_token,
    'providerActionId', null, 'attemptCount', 0, 'wasExisting', false);
end;
$$;

-- ===========================================================================
-- RPC 25 — dispatch_execution_action  [service_role only, A22]
-- reserved -> dispatched. Called immediately BEFORE the provider request.
-- ===========================================================================
create or replace function public.dispatch_execution_action(p_execution_action_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  select * into v_a from public.execution_actions
   where execution_action_id = p_execution_action_id for update;
  if not found then
    raise exception 'ACTION_NOT_FOUND: %', p_execution_action_id using errcode = 'P0001';
  end if;
  if v_a.status <> 'reserved' then
    raise exception 'ILLEGAL_TRANSITION: execution_actions.% -> dispatched', v_a.status
      using errcode = 'P0001';
  end if;

  update public.execution_actions
     set status = 'dispatched', dispatched_at = now(), attempt_count = attempt_count + 1
   where execution_action_id = p_execution_action_id
  returning * into v_a;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (v_a.execution_id, v_a.step_execution_id, p_execution_action_id, 'action',
     'action:dispatched:' || v_a.marker_token || ':' || v_a.attempt_count,
     jsonb_build_object('phase','dispatched','attemptCount', v_a.attempt_count,
                        'markerToken', v_a.marker_token));

  return jsonb_build_object('executionActionId', p_execution_action_id, 'status', 'dispatched',
    'markerToken', v_a.marker_token, 'attemptCount', v_a.attempt_count,
    'dispatchedAt', v_a.dispatched_at, 'providerActionId', v_a.provider_action_id);
end;
$$;

-- ===========================================================================
-- RPC 26 — complete_execution_action  [service_role only, A22]
-- dispatched -> succeeded | failed. TERMINAL: sets completed_at.
-- ===========================================================================
create or replace function public.complete_execution_action(
  p_execution_action_id uuid,
  p_status              text,
  p_provider_action_id  text,
  p_provider_response   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  if p_status not in ('succeeded','failed') then
    raise exception 'INVALID_ACTION_COMPLETION_STATUS: %', p_status using errcode = 'P0001';
  end if;
  select * into v_a from public.execution_actions
   where execution_action_id = p_execution_action_id for update;
  if not found then
    raise exception 'ACTION_NOT_FOUND: %', p_execution_action_id using errcode = 'P0001';
  end if;
  if v_a.status = p_status then
    return jsonb_build_object('executionActionId', p_execution_action_id, 'status', p_status,
      'providerActionId', v_a.provider_action_id, 'wasAlreadyTerminal', true);
  end if;
  if v_a.status <> 'dispatched' then
    raise exception 'ILLEGAL_TRANSITION: execution_actions.% -> %', v_a.status, p_status
      using errcode = 'P0001';
  end if;
  if p_status = 'succeeded' and (p_provider_action_id is null
                                 or length(btrim(p_provider_action_id)) = 0) then
    raise exception 'PROVIDER_ID_REQUIRED_FOR_SUCCESS' using errcode = 'P0001';
  end if;

  update public.execution_actions
     set status = p_status, completed_at = now(),
         provider_action_id     = coalesce(p_provider_action_id, provider_action_id),
         provider_response_json = coalesce(p_provider_response, provider_response_json)
   where execution_action_id = p_execution_action_id
  returning * into v_a;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (v_a.execution_id, v_a.step_execution_id, p_execution_action_id, 'action',
     'action:' || p_status || ':' || v_a.marker_token,
     jsonb_build_object('phase', p_status, 'providerActionId', v_a.provider_action_id,
                        'response', coalesce(p_provider_response, '{}'::jsonb)));

  return jsonb_build_object('executionActionId', p_execution_action_id, 'status', p_status,
    'providerActionId', v_a.provider_action_id, 'completedAt', v_a.completed_at,
    'wasAlreadyTerminal', false);
end;
$$;

-- ===========================================================================
-- RPC 27 — mark_execution_action_for_reconciliation  [service_role only, A22]
-- dispatched -> needs_reconciliation. NOT terminal: completed_at stays NULL.
-- ===========================================================================
create or replace function public.mark_execution_action_for_reconciliation(
  p_execution_action_id uuid, p_reason jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  select * into v_a from public.execution_actions
   where execution_action_id = p_execution_action_id for update;
  if not found then
    raise exception 'ACTION_NOT_FOUND: %', p_execution_action_id using errcode = 'P0001';
  end if;
  if v_a.status = 'needs_reconciliation' then
    return jsonb_build_object('executionActionId', p_execution_action_id,
      'status', 'needs_reconciliation', 'wasAlreadyMarked', true);
  end if;
  if v_a.status <> 'dispatched' then
    raise exception 'ILLEGAL_TRANSITION: execution_actions.% -> needs_reconciliation', v_a.status
      using errcode = 'P0001';
  end if;

  -- completed_at is deliberately NOT set: needs_reconciliation is not terminal,
  -- and ck_execution_actions_completed_pairing would reject a non-null value.
  update public.execution_actions
     set status = 'needs_reconciliation',
         reconciliation_json = coalesce(reconciliation_json, '{}'::jsonb)
           || jsonb_build_object('markedAt', now(), 'reason', coalesce(p_reason,'{}'::jsonb))
   where execution_action_id = p_execution_action_id
  returning * into v_a;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (v_a.execution_id, v_a.step_execution_id, p_execution_action_id, 'action',
     'action:needs_reconciliation:' || v_a.marker_token,
     jsonb_build_object('phase','needs_reconciliation','reason', coalesce(p_reason,'{}'::jsonb)));

  return jsonb_build_object('executionActionId', p_execution_action_id,
    'status', 'needs_reconciliation', 'completedAt', null,
    'attemptCount', v_a.attempt_count, 'wasAlreadyMarked', false);
end;
$$;

-- ===========================================================================
-- RPC 28 — reconcile_execution_action  [service_role only, A22]
-- needs_reconciliation -> succeeded | reserved. Requires positive evidence.
-- ===========================================================================
create or replace function public.reconcile_execution_action(
  p_execution_action_id uuid,
  p_status              text,
  p_provider_action_id  text,
  p_reconciliation      jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  if p_status not in ('succeeded','reserved') then
    raise exception 'INVALID_RECONCILIATION_OUTCOME: % (use abandon_execution_action)', p_status
      using errcode = 'P0001';
  end if;
  if p_reconciliation is null or not meridian.is_json_object(p_reconciliation) then
    raise exception 'RECONCILIATION_EVIDENCE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_a from public.execution_actions
   where execution_action_id = p_execution_action_id for update;
  if not found then
    raise exception 'ACTION_NOT_FOUND: %', p_execution_action_id using errcode = 'P0001';
  end if;
  if v_a.status <> 'needs_reconciliation' then
    raise exception 'ILLEGAL_TRANSITION: execution_actions.% -> %', v_a.status, p_status
      using errcode = 'P0001';
  end if;
  if p_status = 'succeeded' and (p_provider_action_id is null
                                 or length(btrim(p_provider_action_id)) = 0) then
    raise exception 'PROVIDER_ID_REQUIRED_FOR_SUCCESS' using errcode = 'P0001';
  end if;
  -- Returning to 'reserved' requires an explicit proof-of-non-delivery flag.
  if p_status = 'reserved' and coalesce(p_reconciliation->>'provenNotDelivered','') <> 'true' then
    raise exception 'RETRY_REQUIRES_PROVEN_NON_DELIVERY' using errcode = 'P0001';
  end if;

  update public.execution_actions
     set status = p_status,
         provider_action_id = case when p_status = 'succeeded'
                                   then p_provider_action_id else provider_action_id end,
         completed_at  = case when p_status = 'succeeded' then now() else null end,
         dispatched_at = case when p_status = 'reserved'  then null  else dispatched_at end,
         reconciliation_json = coalesce(reconciliation_json,'{}'::jsonb)
           || p_reconciliation || jsonb_build_object('reconciledAt', now(), 'outcome', p_status)
   where execution_action_id = p_execution_action_id
  returning * into v_a;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (v_a.execution_id, v_a.step_execution_id, p_execution_action_id, 'action',
     'action:reconciled:' || v_a.marker_token || ':' || p_status,
     jsonb_build_object('phase','reconciled','outcome', p_status,
                        'providerActionId', v_a.provider_action_id,
                        'evidence', p_reconciliation));

  return jsonb_build_object('executionActionId', p_execution_action_id, 'status', p_status,
    'providerActionId', v_a.provider_action_id, 'completedAt', v_a.completed_at,
    'attemptCount', v_a.attempt_count, 'reconciliation', v_a.reconciliation_json);
end;
$$;

-- ===========================================================================
-- RPC 29 — abandon_execution_action  [service_role only, A22]
-- reserved | needs_reconciliation -> abandoned. TERMINAL.
-- ===========================================================================
create or replace function public.abandon_execution_action(
  p_execution_action_id uuid, p_reconciliation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.execution_actions%rowtype;
begin
  if p_reconciliation is null or not meridian.is_json_object(p_reconciliation) then
    raise exception 'RECONCILIATION_EVIDENCE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_a from public.execution_actions
   where execution_action_id = p_execution_action_id for update;
  if not found then
    raise exception 'ACTION_NOT_FOUND: %', p_execution_action_id using errcode = 'P0001';
  end if;
  if v_a.status = 'abandoned' then
    return jsonb_build_object('executionActionId', p_execution_action_id, 'status', 'abandoned',
      'wasAlreadyTerminal', true);
  end if;
  if v_a.status not in ('reserved','needs_reconciliation') then
    raise exception 'ILLEGAL_TRANSITION: execution_actions.% -> abandoned', v_a.status
      using errcode = 'P0001';
  end if;

  update public.execution_actions
     set status = 'abandoned', completed_at = now(),
         reconciliation_json = coalesce(reconciliation_json,'{}'::jsonb)
           || p_reconciliation || jsonb_build_object('abandonedAt', now())
   where execution_action_id = p_execution_action_id
  returning * into v_a;

  insert into public.execution_events
    (execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json)
  values
    (v_a.execution_id, v_a.step_execution_id, p_execution_action_id, 'action',
     'action:abandoned:' || v_a.marker_token,
     jsonb_build_object('phase','abandoned','evidence', p_reconciliation));

  return jsonb_build_object('executionActionId', p_execution_action_id, 'status', 'abandoned',
    'completedAt', v_a.completed_at, 'wasAlreadyTerminal', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges for RPCs 14–29.
-- ---------------------------------------------------------------------------
revoke all on function public.create_agent(uuid, text, text) from public, anon;
grant  execute on function public.create_agent(uuid, text, text) to authenticated;

revoke all on function public.create_agent_version(uuid, uuid, uuid) from public, anon;
grant  execute on function public.create_agent_version(uuid, uuid, uuid) to authenticated, service_role;

revoke all on function public.record_agent_commit(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.record_agent_commit(uuid, uuid, text, jsonb) to service_role;

revoke all on function public.transition_agent_version(uuid, text) from public, anon;
grant  execute on function public.transition_agent_version(uuid, text) to authenticated, service_role;

revoke all on function public.activate_agent_version(uuid, uuid) from public, anon, service_role;
grant  execute on function public.activate_agent_version(uuid, uuid) to authenticated;

revoke all on function public.create_execution(uuid, uuid, text, text, text, text, char, jsonb)
  from public, anon, authenticated;
grant  execute on function public.create_execution(uuid, uuid, text, text, text, text, char, jsonb)
  to service_role;

revoke all on function public.start_execution(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.start_execution(uuid, text, text) to service_role;

revoke all on function public.complete_execution(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant  execute on function public.complete_execution(uuid, text, jsonb, jsonb) to service_role;

revoke all on function public.fail_execution(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.fail_execution(uuid, jsonb) to service_role;

revoke all on function public.create_manual_review_intake_execution(
  uuid, uuid, text, char, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.create_manual_review_intake_execution(
  uuid, uuid, text, char, text, jsonb, jsonb, jsonb) to service_role;

revoke all on function public.reserve_execution_action(uuid, uuid, text, jsonb, char)
  from public, anon, authenticated;
grant  execute on function public.reserve_execution_action(uuid, uuid, text, jsonb, char)
  to service_role;

revoke all on function public.dispatch_execution_action(uuid) from public, anon, authenticated;
grant  execute on function public.dispatch_execution_action(uuid) to service_role;

revoke all on function public.complete_execution_action(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.complete_execution_action(uuid, text, text, jsonb) to service_role;

revoke all on function public.mark_execution_action_for_reconciliation(uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.mark_execution_action_for_reconciliation(uuid, jsonb)
  to service_role;

revoke all on function public.reconcile_execution_action(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.reconcile_execution_action(uuid, text, text, jsonb) to service_role;

revoke all on function public.abandon_execution_action(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.abandon_execution_action(uuid, jsonb) to service_role;
