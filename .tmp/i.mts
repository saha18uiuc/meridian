process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
const { opsClient } = await import('../packages/ops/src/lib/supabase.js');
const c = opsClient();
const { data } = await c.from('executions').select('execution_id, case_key, status, temporal_workflow_id, temporal_run_id, created_at, execution_events(event_key)').eq('run_type','live').order('created_at');
for (const r of data ?? []) console.log(r.created_at.slice(11,23), r.status.padEnd(8), r.execution_id.slice(0,8), (r.temporal_run_id??'-').slice(0,8), r.case_key, '|', (r as any).execution_events.map((e:any)=>e.event_key).join(','));
