-- Deterministic, non-auth seed data applied by `supabase db reset`.
--
-- Demo users are NOT created here. `auth.users` rows must be created through
-- `auth.admin.createUser` so that Supabase Auth writes its own identity and password records;
-- raw inserts produce accounts that cannot sign in. `pnpm seed` (packages/ops/src/seed-demo.ts)
-- owns that step, and the demo board is seeded through `meridian.seed_whiteboard_graph` so it
-- honours the same graph write-path guarantee as `save_whiteboard_delta`.
--
-- Everything here must therefore be independent of any user.

-- Marker row-free by design: this file intentionally contains no DML. It exists because
-- supabase/config.toml declares a seed path, and an absent file emits a warning on every reset.
select 1 where false;
