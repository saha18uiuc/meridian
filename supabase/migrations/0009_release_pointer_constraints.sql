-- Deferred because agents is created before agent_versions.
alter table public.agents
  add constraint fk_agents_active_version
  foreign key (active_agent_version_id, agent_id)
  references public.agent_versions (agent_version_id, agent_id)
  deferrable initially deferred;

create or replace function meridian.check_active_version_approved()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if new.active_agent_version_id is null then
    return new;
  end if;
  select status into v_status from public.agent_versions
   where agent_version_id = new.active_agent_version_id;
  if v_status is distinct from 'approved' then
    raise exception 'ACTIVE_VERSION_NOT_APPROVED: %', new.active_agent_version_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create constraint trigger tg_agents_active_version_approved
  after insert or update of active_agent_version_id on public.agents
  deferrable initially deferred
  for each row execute function meridian.check_active_version_approved();
