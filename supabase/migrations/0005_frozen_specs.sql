create table public.frozen_specs (
  spec_id                uuid primary key default gen_random_uuid(),
  whiteboard_id          uuid not null references public.whiteboards (whiteboard_id),
  spec_version           integer not null,
  source_revision_no     integer not null,
  source_canvas_hash     char(64) not null,
  source_canvas_json     jsonb not null,
  spec_json              jsonb not null,
  spec_hash              char(64) not null,
  unresolved_comment_ids uuid[] not null default '{}'::uuid[],
  created_by             uuid not null references auth.users (id),
  created_at             timestamptz not null default now(),
  constraint uq_frozen_specs_board_version unique (whiteboard_id, spec_version),
  constraint uq_frozen_specs_spec_hash     unique (spec_hash),
  constraint uq_frozen_specs_spec_board    unique (spec_id, whiteboard_id),
  constraint ck_frozen_specs_version_positive check (spec_version > 0),
  constraint ck_frozen_specs_revision_positive check (source_revision_no > 0),
  constraint ck_frozen_specs_canvas_hash_format check (meridian.is_sha256_hex(source_canvas_hash)),
  constraint ck_frozen_specs_spec_hash_format   check (meridian.is_sha256_hex(spec_hash)),
  constraint ck_frozen_specs_canvas_object check (meridian.is_json_object(source_canvas_json)),
  constraint ck_frozen_specs_spec_object   check (meridian.is_json_object(spec_json)),
  constraint ck_frozen_specs_schema_version check (spec_json->>'schemaVersion' = '1.1')
);

create index ix_frozen_specs_board_created on public.frozen_specs (whiteboard_id, created_at desc);

create trigger tg_frozen_specs_immutable before update or delete on public.frozen_specs
  for each row execute function meridian.reject_mutation();

-- Validate every unresolved_comment_ids entry.
create or replace function meridian.check_frozen_spec_unresolved()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bad uuid;
begin
  select x into v_bad
    from unnest(new.unresolved_comment_ids) x
   where not exists (
     select 1 from public.comments c
      where c.comment_id = x
        and c.whiteboard_id = new.whiteboard_id
        and c.parent_comment_id is null
        and c.status in ('open','answered','rejected'))
   limit 1;
  if v_bad is not null then
    raise exception 'INVALID_UNRESOLVED_COMMENT_ID: %', v_bad using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_frozen_specs_unresolved before insert on public.frozen_specs
  for each row execute function meridian.check_frozen_spec_unresolved();
