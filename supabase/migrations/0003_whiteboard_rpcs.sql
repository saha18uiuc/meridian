create or replace function public.create_whiteboard(p_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001';
  end if;
  if p_title is null or length(btrim(p_title)) = 0 then
    raise exception 'INVALID_TITLE' using errcode = 'P0001';
  end if;
  insert into public.whiteboards (owner_id, title)
  values (auth.uid(), btrim(p_title))
  returning whiteboard_id into v_id;
  return jsonb_build_object('whiteboardId', v_id, 'revisionNo', 1, 'status', 'draft');
end;
$$;

-- [A19] Renaming is a canonical-content change: it participates in revision semantics.
create or replace function public.rename_whiteboard(
  p_whiteboard_id        uuid,
  p_expected_revision_no integer,
  p_title                text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_board     public.whiteboards%rowtype;
  v_title     text;
  v_new_rev   integer;
begin
  -- 1. Normalize and validate the title BEFORE taking any lock.
  if p_title is null then
    raise exception 'INVALID_TITLE: null' using errcode = 'P0001';
  end if;
  v_title := btrim(regexp_replace(p_title, '\s+', ' ', 'g'));
  if length(v_title) < 1 or length(v_title) > 200 then
    raise exception 'INVALID_TITLE: normalized length % not in 1..200', length(v_title)
      using errcode = 'P0001';
  end if;

  -- 2. Lock the board and verify ownership in one statement.
  select * into v_board from public.whiteboards
   where whiteboard_id = p_whiteboard_id and owner_id = auth.uid()
   for update;
  if not found then
    raise exception 'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  if v_board.status = 'archived' then
    raise exception 'WHITEBOARD_ARCHIVED: %', p_whiteboard_id using errcode = 'P0001';
  end if;

  -- 3. Optimistic concurrency, identical to the graph delta contract.
  if v_board.revision_no <> p_expected_revision_no then
    raise exception 'STALE_BOARD_REVISION: current=%', v_board.revision_no using errcode = 'P0001';
  end if;

  -- 4. No-op rule: an unchanged title never increments the revision.
  if v_title = v_board.title then
    return jsonb_build_object(
      'whiteboardId', p_whiteboard_id,
      'title',        v_board.title,
      'revisionNo',   v_board.revision_no,
      'status',       v_board.status,
      'changed',      false);
  end if;

  -- 5. Write the title, increment exactly once, reset review/freeze status.
  --    last_reviewed_revision_no is deliberately NOT touched, so the board
  --    becomes visibly stale relative to its latest review.
  update public.whiteboards
     set title       = v_title,
         revision_no = revision_no + 1,
         status      = case when status in ('review_ready','submitted') then 'draft' else status end
   where whiteboard_id = p_whiteboard_id
  returning revision_no, status into v_new_rev, v_board.status;

  return jsonb_build_object(
    'whiteboardId', p_whiteboard_id,
    'title',        v_title,
    'revisionNo',   v_new_rev,
    'status',       v_board.status,
    'changed',      true);
end;
$$;

create or replace function public.set_whiteboard_status(p_whiteboard_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform meridian.assert_board_owner(p_whiteboard_id);
  if p_status not in ('draft','archived') then
    raise exception 'STATUS_NOT_OPERATOR_SETTABLE: %', p_status using errcode = 'P0001';
  end if;
  update public.whiteboards set status = p_status where whiteboard_id = p_whiteboard_id;
  return jsonb_build_object('whiteboardId', p_whiteboard_id, 'status', p_status);
end;
$$;

-- [A1] The single transactional graph write path.
create or replace function public.save_whiteboard_delta(
  p_whiteboard_id        uuid,
  p_expected_revision_no integer,
  p_node_upserts         jsonb default '[]'::jsonb,
  p_node_deletes         uuid[] default '{}'::uuid[],
  p_edge_upserts         jsonb default '[]'::jsonb,
  p_edge_deletes         uuid[] default '{}'::uuid[],
  p_viewport             jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_board        public.whiteboards%rowtype;
  v_item         jsonb;
  v_id           uuid;
  v_rv           integer;
  v_new_rv       integer;
  v_changed      boolean := false;
  v_node_rvs     jsonb := '{}'::jsonb;
  v_edge_rvs     jsonb := '{}'::jsonb;
  v_deleted      integer;
  -- Normalized copies. NULL arguments are treated as empty, never as errors.
  v_node_ups     jsonb  := coalesce(p_node_upserts, '[]'::jsonb);
  v_edge_ups     jsonb  := coalesce(p_edge_upserts, '[]'::jsonb);
  v_node_dels    uuid[] := coalesce(p_node_deletes, '{}'::uuid[]);
  v_edge_dels    uuid[] := coalesce(p_edge_deletes, '{}'::uuid[]);
  v_node_del_len integer;
  v_edge_del_len integer;
begin
  perform set_config('meridian.in_delta_rpc', 'on', true);

  -- [A-empty-array] array_length() returns NULL, not 0, for an empty array, so
  -- every length comparison below goes through coalesce(array_length(x,1),0).
  -- '{}'::uuid[] and NULL must both behave exactly like "no deletions" and must
  -- never raise DUPLICATE_ID_IN_DELTA.
  v_node_del_len := coalesce(array_length(v_node_dels, 1), 0);
  v_edge_del_len := coalesce(array_length(v_edge_dels, 1), 0);

  -- Shape validation -------------------------------------------------------
  if not meridian.is_json_array(v_node_ups) or not meridian.is_json_array(v_edge_ups) then
    raise exception 'INVALID_DELTA_SHAPE: node/edge upserts must be JSON arrays' using errcode = 'P0001';
  end if;
  if p_viewport is not null and not meridian.is_valid_viewport(p_viewport) then
    raise exception 'INVALID_VIEWPORT' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(v_node_ups) e)
     <> (select count(distinct e->>'nodeId') from jsonb_array_elements(v_node_ups) e) then
    raise exception 'DUPLICATE_ID_IN_DELTA: nodeUpserts' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(v_edge_ups) e)
     <> (select count(distinct e->>'edgeId') from jsonb_array_elements(v_edge_ups) e) then
    raise exception 'DUPLICATE_ID_IN_DELTA: edgeUpserts' using errcode = 'P0001';
  end if;
  if v_node_del_len <> (select count(distinct x) from unnest(v_node_dels) x)::int then
    raise exception 'DUPLICATE_ID_IN_DELTA: nodeDeletes' using errcode = 'P0001';
  end if;
  if v_edge_del_len <> (select count(distinct x) from unnest(v_edge_dels) x)::int then
    raise exception 'DUPLICATE_ID_IN_DELTA: edgeDeletes' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_node_ups) e
             where (e->>'nodeId')::uuid = any(v_node_dels)) then
    raise exception 'ID_IN_UPSERT_AND_DELETE: node' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_edge_ups) e
             where (e->>'edgeId')::uuid = any(v_edge_dels)) then
    raise exception 'ID_IN_UPSERT_AND_DELETE: edge' using errcode = 'P0001';
  end if;

  -- Lock the board ---------------------------------------------------------
  select * into v_board from public.whiteboards
   where whiteboard_id = p_whiteboard_id and owner_id = auth.uid()
   for update;
  if not found then
    raise exception 'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  if v_board.status = 'archived' then
    raise exception 'WHITEBOARD_ARCHIVED: %', p_whiteboard_id using errcode = 'P0001';
  end if;
  if v_board.revision_no <> p_expected_revision_no then
    raise exception 'STALE_BOARD_REVISION: current=%', v_board.revision_no using errcode = 'P0001';
  end if;

  -- 1. Node upserts --------------------------------------------------------
  for v_item in select * from jsonb_array_elements(v_node_ups) loop
    v_id := (v_item->>'nodeId')::uuid;
    v_rv := nullif(v_item->>'rowVersion','')::integer;
    if v_rv is null then
      insert into public.whiteboard_nodes
        (node_id, whiteboard_id, primitive_type, title, node_data_json, position_x, position_y, row_version)
      values (v_id, p_whiteboard_id, v_item->>'primitiveType', v_item->>'title',
              coalesce(v_item->'data','{}'::jsonb),
              (v_item->'position'->>'x')::double precision,
              (v_item->'position'->>'y')::double precision, 1);
      v_new_rv := 1;
    else
      if v_rv <= 0 then
        raise exception 'INVALID_ROW_VERSION: node %', v_id using errcode = 'P0001';
      end if;
      update public.whiteboard_nodes
         set primitive_type = v_item->>'primitiveType',
             title          = v_item->>'title',
             node_data_json = coalesce(v_item->'data','{}'::jsonb),
             position_x     = (v_item->'position'->>'x')::double precision,
             position_y     = (v_item->'position'->>'y')::double precision,
             row_version    = row_version + 1
       where node_id = v_id and whiteboard_id = p_whiteboard_id and row_version = v_rv
      returning row_version into v_new_rv;
      if not found then
        raise exception 'STALE_NODE_ROW_VERSION: %', v_id using errcode = 'P0001';
      end if;
    end if;
    v_node_rvs := v_node_rvs || jsonb_build_object(v_id::text, v_new_rv);
    v_changed := true;
  end loop;

  -- 2. Edge upserts --------------------------------------------------------
  for v_item in select * from jsonb_array_elements(v_edge_ups) loop
    v_id := (v_item->>'edgeId')::uuid;
    v_rv := nullif(v_item->>'rowVersion','')::integer;
    begin
      if v_rv is null then
        insert into public.whiteboard_edges
          (edge_id, whiteboard_id, source_node_id, target_node_id, label, condition_json, priority, row_version)
        values (v_id, p_whiteboard_id, (v_item->>'sourceNodeId')::uuid, (v_item->>'targetNodeId')::uuid,
                v_item->>'label',
                -- An unconditional edge arrives as `"condition": null`, which is jsonb `null` and
                -- not SQL NULL. `ck_whiteboard_edges_condition_object` admits an object or SQL NULL
                -- and nothing else, so passing it through rejected every plain arrow drawn on the
                -- board. `EdgeUpsertSchema` defaults the field to null, so this was every arrow.
                nullif(v_item->'condition', 'null'::jsonb),
                coalesce((v_item->>'priority')::smallint, 0::smallint), 1);
        v_new_rv := 1;
      else
        if v_rv <= 0 then
          raise exception 'INVALID_ROW_VERSION: edge %', v_id using errcode = 'P0001';
        end if;
        update public.whiteboard_edges
           set source_node_id = (v_item->>'sourceNodeId')::uuid,
               target_node_id = (v_item->>'targetNodeId')::uuid,
               label          = v_item->>'label',
               condition_json = nullif(v_item->'condition', 'null'::jsonb),
               priority       = coalesce((v_item->>'priority')::smallint, 0::smallint),
               row_version    = row_version + 1
         where edge_id = v_id and whiteboard_id = p_whiteboard_id and row_version = v_rv
        returning row_version into v_new_rv;
        if not found then
          raise exception 'STALE_EDGE_ROW_VERSION: %', v_id using errcode = 'P0001';
        end if;
      end if;
    exception when foreign_key_violation then
      raise exception 'EDGE_ENDPOINT_NOT_ON_BOARD: %', v_id using errcode = 'P0001';
    end;
    v_edge_rvs := v_edge_rvs || jsonb_build_object(v_id::text, v_new_rv);
    v_changed := true;
  end loop;

  -- 3. Edge deletes BEFORE node deletes ------------------------------------
  if v_edge_del_len > 0 then
    delete from public.whiteboard_edges
     where whiteboard_id = p_whiteboard_id and edge_id = any(v_edge_dels);
    get diagnostics v_deleted = row_count;
    if v_deleted <> v_edge_del_len then
      raise exception 'DELETE_TARGET_NOT_FOUND: edge (expected %, deleted %)', v_edge_del_len, v_deleted
        using errcode = 'P0001';
    end if;
    v_changed := true;
  end if;

  -- 4. Node deletes (cascades incident edges) ------------------------------
  if v_node_del_len > 0 then
    delete from public.whiteboard_nodes
     where whiteboard_id = p_whiteboard_id and node_id = any(v_node_dels);
    get diagnostics v_deleted = row_count;
    if v_deleted <> v_node_del_len then
      raise exception 'DELETE_TARGET_NOT_FOUND: node (expected %, deleted %)', v_node_del_len, v_deleted
        using errcode = 'P0001';
    end if;
    v_changed := true;
  end if;

  -- 5. Viewport ------------------------------------------------------------
  if p_viewport is not null and p_viewport <> v_board.viewport_json then
    update public.whiteboards set viewport_json = p_viewport where whiteboard_id = p_whiteboard_id;
    v_changed := true;
  end if;

  -- 6. Revision increment (exactly once, only when something changed) ------
  if v_changed then
    update public.whiteboards
       set revision_no = revision_no + 1,
           status = case when status in ('review_ready','submitted') then 'draft' else status end
     where whiteboard_id = p_whiteboard_id
    returning revision_no into v_board.revision_no;
  end if;

  perform set_config('meridian.in_delta_rpc', 'off', true);
  return jsonb_build_object(
    'revisionNo', v_board.revision_no,
    'changed', v_changed,
    'nodeRowVersions', v_node_rvs,
    'edgeRowVersions', v_edge_rvs
  );
end;
$$;

revoke all on function public.create_whiteboard(text) from public, anon;
revoke all on function public.rename_whiteboard(uuid, integer, text) from public, anon;
revoke all on function public.set_whiteboard_status(uuid, text) from public, anon;
revoke all on function public.save_whiteboard_delta(uuid, integer, jsonb, uuid[], jsonb, uuid[], jsonb) from public, anon;
grant execute on function public.create_whiteboard(text) to authenticated;
grant execute on function public.rename_whiteboard(uuid, integer, text) to authenticated;
grant execute on function public.set_whiteboard_status(uuid, text) to authenticated;
grant execute on function public.save_whiteboard_delta(uuid, integer, jsonb, uuid[], jsonb, uuid[], jsonb) to authenticated;
