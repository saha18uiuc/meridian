alter table public.whiteboards       enable row level security;
alter table public.whiteboard_nodes  enable row level security;
alter table public.whiteboard_edges  enable row level security;
alter table public.review_sessions   enable row level security;
alter table public.comments          enable row level security;
alter table public.frozen_specs      enable row level security;
alter table public.agents            enable row level security;
alter table public.agent_versions    enable row level security;
alter table public.executions        enable row level security;
alter table public.execution_steps   enable row level security;
alter table public.execution_events  enable row level security;
alter table public.execution_actions enable row level security;

-- [A1] Read-only browser access to the board and its graph.
create policy p_whiteboards_select on public.whiteboards
  for select to authenticated using (owner_id = auth.uid());

create policy p_nodes_select on public.whiteboard_nodes
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = whiteboard_nodes.whiteboard_id and w.owner_id = auth.uid()));

create policy p_edges_select on public.whiteboard_edges
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = whiteboard_edges.whiteboard_id and w.owner_id = auth.uid()));

create policy p_review_sessions_select on public.review_sessions
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = review_sessions.whiteboard_id and w.owner_id = auth.uid()));

create policy p_comments_select on public.comments
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = comments.whiteboard_id and w.owner_id = auth.uid()));

create policy p_frozen_specs_select on public.frozen_specs
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = frozen_specs.whiteboard_id and w.owner_id = auth.uid()));

create policy p_agents_select on public.agents
  for select to authenticated using (exists (
    select 1 from public.whiteboards w
     where w.whiteboard_id = agents.whiteboard_id and w.owner_id = auth.uid()));

create policy p_agent_versions_select on public.agent_versions
  for select to authenticated using (exists (
    select 1 from public.agents a join public.whiteboards w using (whiteboard_id)
     where a.agent_id = agent_versions.agent_id and w.owner_id = auth.uid()));

create policy p_executions_select on public.executions
  for select to authenticated using (exists (
    select 1 from public.agents a join public.whiteboards w using (whiteboard_id)
     where a.agent_id = executions.agent_id and w.owner_id = auth.uid()));

create policy p_execution_steps_select on public.execution_steps
  for select to authenticated using (exists (
    select 1 from public.executions e join public.agents a on a.agent_id = e.agent_id
      join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
     where e.execution_id = execution_steps.execution_id and w.owner_id = auth.uid()));

create policy p_execution_events_select on public.execution_events
  for select to authenticated using (exists (
    select 1 from public.executions e join public.agents a on a.agent_id = e.agent_id
      join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
     where e.execution_id = execution_events.execution_id and w.owner_id = auth.uid()));

create policy p_execution_actions_select on public.execution_actions
  for select to authenticated using (exists (
    select 1 from public.executions e join public.agents a on a.agent_id = e.agent_id
      join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
     where e.execution_id = execution_actions.execution_id and w.owner_id = auth.uid()));

-- No INSERT/UPDATE/DELETE policy exists on ANY application table for browser roles.
revoke insert, update, delete on
  public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
  public.review_sessions, public.comments, public.frozen_specs,
  public.agents, public.agent_versions,
  public.executions, public.execution_steps, public.execution_events, public.execution_actions
  from anon, authenticated;

revoke all on public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
  public.review_sessions, public.comments, public.frozen_specs,
  public.agents, public.agent_versions,
  public.executions, public.execution_steps, public.execution_events, public.execution_actions
  from anon;

grant select on
  public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
  public.review_sessions, public.comments, public.frozen_specs,
  public.agents, public.agent_versions,
  public.executions, public.execution_steps, public.execution_events, public.execution_actions
  to authenticated;

-- Supabase's current default privileges hand the API roles no DML on tables created in `public`,
-- so the trusted server's access is stated here instead of inherited. Granting it back is not a
-- weakening: `service_role` is the Next.js server, the Temporal worker, and the operator CLI, and
-- every invariant that matters to them is a trigger or a constraint, not a missing grant. In
-- particular the graph tables are granted deliberately, so that a direct service-role write is
-- refused by `meridian.assert_delta_context` — proof that the delta marker is transaction-local
-- rather than an accident of privilege.
grant select, insert, update, delete on
  public.whiteboards, public.whiteboard_nodes, public.whiteboard_edges,
  public.review_sessions, public.comments, public.frozen_specs,
  public.agents, public.agent_versions,
  public.executions, public.execution_steps, public.execution_events, public.execution_actions
  to service_role;

-- Append-only enforcement.
create trigger tg_execution_events_append_only before update or delete on public.execution_events
  for each row execute function meridian.reject_mutation();
revoke update, delete on public.execution_events from anon, authenticated, service_role;
