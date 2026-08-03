create table public.execution_actions (
  execution_action_id   uuid primary key default gen_random_uuid(),
  execution_id          uuid not null references public.executions (execution_id) on delete cascade,
  step_execution_id     uuid,
  action_type           text not null,
  idempotency_key       char(64) not null,
  marker_token          text not null,
  status                text not null default 'reserved',
  request_payload_json  jsonb not null default '{}'::jsonb,
  provider_action_id    text,
  provider_response_json jsonb,
  reconciliation_json   jsonb,
  attempt_count         integer not null default 0,
  created_at            timestamptz not null default now(),
  dispatched_at         timestamptz,
  completed_at          timestamptz,
  constraint uq_execution_actions_idem unique (idempotency_key),
  constraint uq_execution_actions_id_execution unique (execution_action_id, execution_id),
  constraint ck_execution_actions_type
    check (action_type in ('mail.send','mail.draft','mail.reply','browser.write','human.handoff')),
  constraint ck_execution_actions_status
    check (status in ('reserved','dispatched','succeeded','failed','needs_reconciliation','abandoned')),
  constraint ck_execution_actions_idem_format check (meridian.is_sha256_hex(idempotency_key)),
  constraint ck_execution_actions_marker check (marker_token = left(idempotency_key, 12)),
  constraint ck_execution_actions_payload_object check (meridian.is_json_object(request_payload_json)),
  constraint ck_execution_actions_attempts check (attempt_count >= 0),
  constraint ck_execution_actions_dispatched_pairing
    check (status = 'reserved' or status = 'abandoned' or dispatched_at is not null),
  -- [A22] Terminal states are EXACTLY succeeded, failed, abandoned. In
  -- particular needs_reconciliation is NOT terminal and must keep a NULL
  -- completed_at; this biconditional makes that a database guarantee.
  constraint ck_execution_actions_completed_pairing
    check ((status in ('succeeded','failed','abandoned')) = (completed_at is not null)),
  constraint ck_execution_actions_success_has_provider_id
    check (status <> 'succeeded' or provider_action_id is not null),
  constraint ck_execution_actions_reconciliation_evidence
    check (status <> 'abandoned' or reconciliation_json is not null),
  constraint ck_execution_actions_reconciliation_object
    check (reconciliation_json is null or meridian.is_json_object(reconciliation_json)),
  constraint ck_execution_actions_dispatch_counts
    check (status = 'reserved' or attempt_count > 0),
  -- [A25] Same composite-lineage and column-specific nulling rule as events.
  constraint fk_execution_actions_step
    foreign key (step_execution_id, execution_id)
    references public.execution_steps (step_execution_id, execution_id)
    on delete set null (step_execution_id)
);

create index ix_execution_actions_execution on public.execution_actions (execution_id, created_at);
create index ix_execution_actions_open
  on public.execution_actions (status) where status in ('dispatched','needs_reconciliation');

alter table public.execution_events
  add constraint fk_execution_events_action
  foreign key (execution_action_id, execution_id)
  references public.execution_actions (execution_action_id, execution_id) on delete cascade;
