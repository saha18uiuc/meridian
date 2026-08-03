-- Documentation mirror of the storage policy block applied by
-- supabase/migrations/0014_storage_and_seed_support.sql. The migration is authoritative; this
-- file exists so the storage contract can be reviewed without reading the migration.
--
-- Four private buckets. Reads are lineage-scoped:
--     storage.objects -> executions -> agents -> whiteboards.owner_id = auth.uid()
-- Writes are service-role only, because artifacts are produced by the Temporal worker.
--
-- Path convention: <bucket>/<execution_id>/<step_instance_key>/<filename>
-- The first path segment is the execution id, which is what makes the lineage join possible.

-- Buckets (public = false on every one).
--   emails, attachments, ocr, screenshots

-- select: authenticated, only artifacts belonging to an execution the caller's board owns.
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
         and e.execution_id::text = (storage.foldername(name))[1]));

-- insert/update/delete: service role only.
create policy p_storage_service_write on storage.objects
  for insert to service_role
  with check (bucket_id in ('emails','attachments','ocr','screenshots'));
create policy p_storage_service_update on storage.objects
  for update to service_role
  using (bucket_id in ('emails','attachments','ocr','screenshots'));
create policy p_storage_service_delete on storage.objects
  for delete to service_role
  using (bucket_id in ('emails','attachments','ocr','screenshots'));
