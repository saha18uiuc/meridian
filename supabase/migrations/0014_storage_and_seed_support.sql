insert into storage.buckets (id, name, public) values
  ('emails','emails',false), ('attachments','attachments',false),
  ('ocr','ocr',false), ('screenshots','screenshots',false)
on conflict (id) do nothing;

-- Path convention: <bucket>/<execution_id>/<step_instance_key>/<filename>
create policy p_storage_read_own_execution on storage.objects
  for select to authenticated
  using (
    bucket_id in ('emails','attachments','ocr','screenshots')
    and exists (
      select 1
        from public.executions e
        join public.agents a on a.agent_id = e.agent_id
        join public.whiteboards w on w.whiteboard_id = a.whiteboard_id
       where w.owner_id = auth.uid()
         -- Qualified deliberately: `agents` also has a `name`, and an unqualified reference here
         -- binds to it rather than to the object path, which silently makes the policy match
         -- nothing at all.
         and e.execution_id::text = (storage.foldername(storage.objects.name))[1]));

create policy p_storage_service_write on storage.objects
  for insert to service_role
  with check (bucket_id in ('emails','attachments','ocr','screenshots'));
create policy p_storage_service_update on storage.objects
  for update to service_role
  using (bucket_id in ('emails','attachments','ocr','screenshots'));
create policy p_storage_service_delete on storage.objects
  for delete to service_role
  using (bucket_id in ('emails','attachments','ocr','screenshots'));

-- Seed helper honours the same write-path guarantee.
create or replace function meridian.seed_whiteboard_graph(p_owner uuid, p_board jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_board_id uuid; v_item jsonb;
begin
  perform set_config('meridian.in_delta_rpc', 'on', true);
  -- The fixture may name its own board ID, exactly as it already names every node and edge ID.
  -- The canonical snapshot carries `metadata.whiteboardId`, so a server-assigned ID would give the
  -- same fixture a different canvas hash and a different spec hash on every machine, and no
  -- checked-in `spec.snapshot.json` could correspond to a real freeze.
  insert into public.whiteboards (whiteboard_id, owner_id, title, viewport_json)
  values (coalesce((p_board->>'whiteboardId')::uuid, gen_random_uuid()), p_owner,
          p_board->>'title', coalesce(p_board->'viewport','{"x":0,"y":0,"zoom":1}'::jsonb))
  returning whiteboard_id into v_board_id;

  for v_item in select * from jsonb_array_elements(p_board->'nodes') loop
    insert into public.whiteboard_nodes
      (node_id, whiteboard_id, primitive_type, title, node_data_json, position_x, position_y)
    values ((v_item->>'nodeId')::uuid, v_board_id, v_item->>'primitiveType', v_item->>'title',
            -- `->` yields the jsonb scalar `null` for a JSON null, not SQL NULL, and `coalesce`
            -- does not see it. `nullif` is what turns the fixture's `"data": null` back into a
            -- missing value the default can answer for.
            coalesce(nullif(v_item->'data', 'null'::jsonb), '{}'::jsonb),
            (v_item->'position'->>'x')::double precision,
            (v_item->'position'->>'y')::double precision);
  end loop;

  for v_item in select * from jsonb_array_elements(p_board->'edges') loop
    insert into public.whiteboard_edges
      (edge_id, whiteboard_id, source_node_id, target_node_id, label, condition_json, priority)
    values ((v_item->>'edgeId')::uuid, v_board_id, (v_item->>'sourceNodeId')::uuid,
            -- Same reason as the node data above: an unconditional edge is written `"condition":
            -- null` in the fixture, and passing that through as jsonb `null` would fail
            -- `ck_whiteboard_edges_condition_object`, which admits only an object or SQL NULL.
            (v_item->>'targetNodeId')::uuid, v_item->>'label',
            nullif(v_item->'condition', 'null'::jsonb),
            coalesce((v_item->>'priority')::smallint, 0::smallint));
  end loop;

  perform set_config('meridian.in_delta_rpc', 'off', true);
  return v_board_id;
end;
$$;

revoke all on function meridian.seed_whiteboard_graph(uuid, jsonb) from public, anon, authenticated;
grant execute on function meridian.seed_whiteboard_graph(uuid, jsonb) to service_role;
