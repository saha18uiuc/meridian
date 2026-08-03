-- [A7] First-class logical agent.
create table public.agents (
  agent_id                uuid primary key default gen_random_uuid(),
  whiteboard_id           uuid not null references public.whiteboards (whiteboard_id),
  deployment_key          text not null,
  name                    text not null,
  status                  text not null default 'draft',
  active_agent_version_id uuid,                                   -- [A17] release pointer
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_agents_deployment_key unique (deployment_key),
  constraint uq_agents_agent_whiteboard unique (agent_id, whiteboard_id),
  constraint ck_agents_status check (status in ('draft','active','paused','archived')),
  constraint ck_agents_deployment_key_format check (deployment_key ~ '^[a-z][a-z0-9-]{2,63}$'),
  constraint ck_agents_name_nonempty check (length(btrim(name)) > 0),
  constraint ck_agents_active_requires_version
    check (status <> 'active' or active_agent_version_id is not null),
  constraint ck_agents_archived_has_no_pointer
    check (status <> 'archived' or active_agent_version_id is null)
);
create index ix_agents_whiteboard on public.agents (whiteboard_id);

create table public.agent_versions (
  agent_version_id       uuid primary key default gen_random_uuid(),
  agent_id               uuid not null,
  spec_id                uuid not null,
  whiteboard_id          uuid not null,                            -- lineage discriminator
  version_no             integer not null,
  parent_agent_version_id uuid,
  status                 text not null default 'generated',
  code_path              text not null,
  git_commit_sha         text,
  build_manifest_json    jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  approved_at            timestamptz,
  constraint uq_agent_versions_agent_version unique (agent_id, version_no),
  constraint uq_agent_versions_id_agent      unique (agent_version_id, agent_id),
  constraint uq_agent_versions_code_path     unique (code_path),
  constraint ck_agent_versions_status check (status in ('generated','evaluating','approved','failed')),
  constraint ck_agent_versions_version_positive check (version_no > 0),
  constraint ck_agent_versions_sha_format
    check (git_commit_sha is null or meridian.is_git_sha1(git_commit_sha)),
  constraint ck_agent_versions_manifest_object check (meridian.is_json_object(build_manifest_json)),
  constraint ck_agent_versions_code_path_format
    check (code_path ~ '^generated-agents/[a-z][a-z0-9-]{2,63}/v[0-9]{3,}$'),
  constraint ck_agent_versions_not_self_parent
    check (parent_agent_version_id is null or parent_agent_version_id <> agent_version_id),
  constraint ck_agent_versions_approved_at check ((status = 'approved') = (approved_at is not null)),
  constraint fk_agent_versions_agent_lineage
    foreign key (agent_id, whiteboard_id) references public.agents (agent_id, whiteboard_id),
  constraint fk_agent_versions_spec_lineage
    foreign key (spec_id, whiteboard_id) references public.frozen_specs (spec_id, whiteboard_id),
  constraint fk_agent_versions_parent_same_agent
    foreign key (parent_agent_version_id, agent_id)
    references public.agent_versions (agent_version_id, agent_id)
);

create index ix_agent_versions_agent_status on public.agent_versions (agent_id, status, version_no desc);
create index ix_agent_versions_spec on public.agent_versions (spec_id);

create trigger tg_agents_touch before update on public.agents
  for each row execute function meridian.touch_updated_at();
