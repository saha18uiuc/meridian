create table public.executions (
  execution_id          uuid primary key default gen_random_uuid(),
  agent_version_id      uuid not null,
  agent_id              uuid not null,
  run_type              text not null,
  case_key              text not null,
  business_key          text,
  temporal_workflow_id  text,
  temporal_run_id       text,                       -- [A24] first execution run id
  idempotency_key       char(64) not null,
  status                text not null default 'queued',
  input_ref_json        jsonb not null default '{}'::jsonb,
  expected_summary_json jsonb,
  output_summary_json   jsonb,
  diff_summary_json     jsonb,
  error_json            jsonb,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  constraint uq_executions_idempotency_key unique (idempotency_key),
  constraint uq_executions_id_agent unique (execution_id, agent_id),
  constraint ck_executions_run_type check (run_type in ('eval','live')),
  constraint ck_executions_status check (status in ('queued','running','passed','failed','error')),
  constraint ck_executions_idem_format check (meridian.is_sha256_hex(idempotency_key)),
  constraint ck_executions_case_key_nonempty check (length(btrim(case_key)) > 0),
  constraint ck_executions_input_object check (meridian.is_json_object(input_ref_json)),
  constraint ck_executions_started_when_left_queued
    check (status = 'queued' or status = 'error' or started_at is not null),
  constraint ck_executions_completed_pairing
    check ((status in ('passed','failed','error')) = (completed_at is not null)),
  constraint ck_executions_time_order
    check ((started_at is null or started_at >= created_at)
       and (completed_at is null or started_at is null or completed_at >= started_at)),
  -- [A23] A live run must have a business key UNLESS it is the deliberate
  -- manual-review intake path (no reliable or conflicting key) or it errored.
  constraint ck_executions_live_needs_business_key
    check (run_type <> 'live'
        or status = 'queued'
        or business_key is not null
        or error_json is not null
        or output_summary_json->>'outcome' = 'manual_review'),
  -- [A23] The manual-review intake path never has a workflow.
  constraint ck_executions_manual_review_has_no_workflow
    check (output_summary_json->>'outcome' is distinct from 'manual_review'
        or temporal_workflow_id is null),
  constraint ck_executions_run_id_requires_workflow_id
    check (temporal_run_id is null or temporal_workflow_id is not null),
  constraint fk_executions_version_agent
    foreign key (agent_version_id, agent_id)
    references public.agent_versions (agent_version_id, agent_id)
);

create index ix_executions_version_type_created on public.executions (agent_version_id, run_type, created_at desc);
create index ix_executions_business_key on public.executions (business_key);
create index ix_executions_agent_created on public.executions (agent_id, created_at desc);
-- Partial uniqueness for live workflow identity: one non-terminal execution per workflow id.
create unique index uq_executions_active_workflow
  on public.executions (temporal_workflow_id)
  where temporal_workflow_id is not null and status in ('queued','running');

create table public.execution_steps (
  step_execution_id   uuid primary key default gen_random_uuid(),
  execution_id        uuid not null references public.executions (execution_id) on delete cascade,
  node_id             uuid,
  step_key            text not null,
  step_instance_key   text not null,               -- [A6]
  sequence_no         integer not null,            -- display ordinal, NOT unique
  attempt_no          smallint not null default 1,
  status              text not null default 'queued',
  input_summary_json  jsonb not null default '{}'::jsonb,
  output_summary_json jsonb not null default '{}'::jsonb,
  error_json          jsonb,
  started_at          timestamptz,
  completed_at        timestamptz,
  constraint uq_execution_steps_instance_attempt unique (execution_id, step_instance_key, attempt_no),
  constraint uq_execution_steps_id_execution unique (step_execution_id, execution_id),
  constraint ck_execution_steps_status check (status in ('queued','running','succeeded','failed','skipped')),
  constraint ck_execution_steps_sequence_positive check (sequence_no > 0),
  constraint ck_execution_steps_attempt_positive check (attempt_no > 0),
  constraint ck_execution_steps_keys_nonempty
    check (length(btrim(step_key)) > 0 and length(btrim(step_instance_key)) > 0),
  constraint ck_execution_steps_input_object check (meridian.is_json_object(input_summary_json)),
  constraint ck_execution_steps_output_object check (meridian.is_json_object(output_summary_json)),
  constraint ck_execution_steps_completed_pairing
    check ((status in ('succeeded','failed','skipped')) = (completed_at is not null)),
  constraint ck_execution_steps_started_pairing
    check (status in ('queued','skipped') or started_at is not null),
  constraint ck_execution_steps_failed_has_error check (status <> 'failed' or error_json is not null)
);

create index ix_execution_steps_exec_sequence on public.execution_steps (execution_id, sequence_no);
create index ix_execution_steps_exec_node_status on public.execution_steps (execution_id, node_id, status);

create table public.execution_events (
  event_id            bigint generated always as identity primary key,
  execution_id        uuid not null references public.executions (execution_id) on delete cascade,
  step_execution_id   uuid,
  execution_action_id uuid,                        -- composite FK added in 0008
  event_type          text not null,
  event_key           text,
  payload_json        jsonb not null,
  storage_path        text,
  idempotency_key     char(64),
  created_at          timestamptz not null default now(),
  constraint ck_execution_events_type
    check (event_type in ('evidence','action','state_transition','metric')),
  constraint ck_execution_events_payload_object check (meridian.is_json_object(payload_json)),
  constraint ck_execution_events_idem_format
    check (idempotency_key is null or meridian.is_sha256_hex(idempotency_key)),
  constraint ck_execution_events_action_has_action_id
    check (event_type <> 'action' or execution_action_id is not null),
  -- [A25] Composite lineage: a referenced step ALWAYS belongs to the same execution.
  -- ON DELETE SET NULL (step_execution_id) is the PostgreSQL 15+ column-specific
  -- form. Without the column list PostgreSQL would attempt to null EVERY
  -- referencing column, including the NOT NULL execution_id, and the delete
  -- would fail. Migration 0001 asserts server_version_num >= 150000.
  constraint fk_execution_events_step
    foreign key (step_execution_id, execution_id)
    references public.execution_steps (step_execution_id, execution_id)
    on delete set null (step_execution_id)
);

create index ix_execution_events_exec on public.execution_events (execution_id, event_id);
create index ix_execution_events_step on public.execution_events (step_execution_id, event_id);
create unique index uq_execution_events_idem
  on public.execution_events (idempotency_key) where idempotency_key is not null;
