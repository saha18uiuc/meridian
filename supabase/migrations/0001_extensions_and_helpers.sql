do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'MERIDIAN_REQUIRES_POSTGRES_15_OR_LATER: found %', current_setting('server_version');
  end if;
end $$;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists meridian;
revoke all on schema meridian from public, anon, authenticated;
grant usage on schema meridian to postgres, service_role;

-- Generic updated_at maintenance.
create or replace function meridian.touch_updated_at()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Transaction-local marker predicates.
create or replace function meridian.in_delta_rpc() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('meridian.in_delta_rpc', true), 'off') = 'on';
$$;

create or replace function meridian.in_review_finalize() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('meridian.in_review_finalize', true), 'off') = 'on';
$$;

-- Guard trigger used by whiteboard_nodes / whiteboard_edges.
create or replace function meridian.assert_delta_context()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not meridian.in_delta_rpc() then
    raise exception 'WHITEBOARD_GRAPH_DIRECT_WRITE_FORBIDDEN: table % may only be written inside save_whiteboard_delta', tg_table_name
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

-- Generic immutability rejection.
create or replace function meridian.reject_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'IMMUTABLE_ROW: % rows may not be % after insert', tg_table_name, lower(tg_op)
    using errcode = 'P0001';
end;
$$;

-- Shape helpers.
create or replace function meridian.is_json_object(v jsonb) returns boolean
language sql immutable set search_path = '' as $$ select v is not null and jsonb_typeof(v) = 'object'; $$;

create or replace function meridian.is_json_array(v jsonb) returns boolean
language sql immutable set search_path = '' as $$ select v is not null and jsonb_typeof(v) = 'array'; $$;

create or replace function meridian.is_sha256_hex(v text) returns boolean
language sql immutable set search_path = '' as $$ select v ~ '^[0-9a-f]{64}$'; $$;

create or replace function meridian.is_git_sha1(v text) returns boolean
language sql immutable set search_path = '' as $$ select v ~ '^[0-9a-f]{40}$'; $$;

-- Viewport shape validator: exactly {x,y,zoom}, x/y finite, zoom finite and > 0.
create or replace function meridian.is_valid_viewport(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and (select count(*) from jsonb_object_keys(v)) = 3
     and v ? 'x' and v ? 'y' and v ? 'zoom'
     and jsonb_typeof(v->'x') = 'number'
     and jsonb_typeof(v->'y') = 'number'
     and jsonb_typeof(v->'zoom') = 'number'
     and (v->>'x')::double precision = (v->>'x')::double precision   -- rejects NaN
     and (v->>'y')::double precision = (v->>'y')::double precision
     and (v->>'zoom')::double precision > 0
     and (v->>'zoom')::double precision < 'infinity'::double precision
     and (v->>'x')::double precision > '-infinity'::double precision
     and (v->>'x')::double precision < 'infinity'::double precision
     and (v->>'y')::double precision > '-infinity'::double precision
     and (v->>'y')::double precision < 'infinity'::double precision;
$$;

-- Board ownership assertion used by every RPC.
create or replace function meridian.assert_board_owner(p_whiteboard_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.whiteboards w
    where w.whiteboard_id = p_whiteboard_id and w.owner_id = auth.uid()
  ) then
    raise exception 'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN: %', p_whiteboard_id using errcode = 'P0001';
  end if;
end;
$$;
