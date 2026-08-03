create table public.whiteboards (
  whiteboard_id             uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null references auth.users (id) on delete cascade,
  title                     text not null,
  status                    text not null default 'draft',
  revision_no               integer not null default 1,
  viewport_json             jsonb not null default '{"x":0,"y":0,"zoom":1}'::jsonb,
  last_reviewed_revision_no integer,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint ck_whiteboards_status
    check (status in ('draft','review_ready','submitted','archived')),
  constraint ck_whiteboards_revision_positive check (revision_no > 0),
  constraint ck_whiteboards_title_nonempty check (length(btrim(title)) > 0),
  constraint ck_whiteboards_viewport_shape check (meridian.is_valid_viewport(viewport_json)),
  constraint ck_whiteboards_last_reviewed
    check (last_reviewed_revision_no is null
           or (last_reviewed_revision_no > 0 and last_reviewed_revision_no <= revision_no)),
  constraint uq_whiteboards_id_owner unique (whiteboard_id, owner_id)
);

create index ix_whiteboards_owner_updated on public.whiteboards (owner_id, updated_at desc);

create table public.whiteboard_nodes (
  node_id        uuid primary key default gen_random_uuid(),
  whiteboard_id  uuid not null references public.whiteboards (whiteboard_id) on delete cascade,
  primitive_type text not null,
  title          text not null,
  node_data_json jsonb not null default '{}'::jsonb,
  position_x     double precision not null,
  position_y     double precision not null,
  row_version    integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_whiteboard_nodes_board_node unique (whiteboard_id, node_id),
  constraint ck_whiteboard_nodes_primitive_type
    check (primitive_type in ('input','action','rule','outcome')),
  constraint ck_whiteboard_nodes_title_nonempty check (length(btrim(title)) > 0),
  constraint ck_whiteboard_nodes_data_is_object check (meridian.is_json_object(node_data_json)),
  constraint ck_whiteboard_nodes_row_version_positive check (row_version > 0),
  constraint ck_whiteboard_nodes_position_finite
    check (position_x = position_x and position_y = position_y
           and abs(position_x) < 'infinity'::double precision
           and abs(position_y) < 'infinity'::double precision)
);

create index ix_whiteboard_nodes_board_type on public.whiteboard_nodes (whiteboard_id, primitive_type);

create table public.whiteboard_edges (
  edge_id        uuid primary key default gen_random_uuid(),
  whiteboard_id  uuid not null references public.whiteboards (whiteboard_id) on delete cascade,
  source_node_id uuid not null,
  target_node_id uuid not null,
  label          text,
  condition_json jsonb,
  priority       smallint not null default 0,
  row_version    integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_whiteboard_edges_board_edge unique (whiteboard_id, edge_id),
  constraint ck_whiteboard_edges_row_version_positive check (row_version > 0),
  constraint ck_whiteboard_edges_condition_object
    check (condition_json is null or meridian.is_json_object(condition_json))
);

-- [A2] Edge endpoint integrity is a database guarantee, not a design intention.
alter table public.whiteboard_edges
  add constraint fk_whiteboard_edges_source
  foreign key (whiteboard_id, source_node_id)
  references public.whiteboard_nodes (whiteboard_id, node_id)
  on delete cascade;

alter table public.whiteboard_edges
  add constraint fk_whiteboard_edges_target
  foreign key (whiteboard_id, target_node_id)
  references public.whiteboard_nodes (whiteboard_id, node_id)
  on delete cascade;

create index ix_whiteboard_edges_board_source on public.whiteboard_edges (whiteboard_id, source_node_id);
create index ix_whiteboard_edges_board_target on public.whiteboard_edges (whiteboard_id, target_node_id);

create trigger tg_whiteboards_touch before update on public.whiteboards
  for each row execute function meridian.touch_updated_at();
create trigger tg_whiteboard_nodes_touch before update on public.whiteboard_nodes
  for each row execute function meridian.touch_updated_at();
create trigger tg_whiteboard_edges_touch before update on public.whiteboard_edges
  for each row execute function meridian.touch_updated_at();

-- [A1] Statement-level guard: no graph write outside save_whiteboard_delta.
create trigger tg_whiteboard_nodes_write_guard
  before insert or update or delete on public.whiteboard_nodes
  for each statement execute function meridian.assert_delta_context();
create trigger tg_whiteboard_edges_write_guard
  before insert or update or delete on public.whiteboard_edges
  for each statement execute function meridian.assert_delta_context();
