# Deploying Meridian

This describes a deployment a stranger can reach from their own machine with nothing installed
locally. Everything below fits inside free tiers.

## Topology, and why it is split this way

| Piece                   | Runs on          | Why there                                                                                                                                      |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app (`apps/web`)    | Vercel           | Request/response only. Next.js is what Vercel is for.                                                                                          |
| Worker (`apps/backend`) | A container host | Holds long-poll connections to Temporal and runs workflows that outlive any request. This cannot be a serverless function; see the note below. |
| Database, auth, storage | Supabase         | Already the database layer; the hosted project is the same schema as local.                                                                    |
| Durable execution       | Temporal Cloud   | Already configured for this repository.                                                                                                        |
| Third-party tool calls  | Composio         | Already configured. Gmail stays in mock mode; see "Mock mode" below.                                                                           |

The split is not a preference. A Temporal worker polls its task queue continuously and must stay
alive between activities, across a workflow timer that may sleep for days. A serverless function is
billed and bounded per request and is frozen the moment it returns, so a worker hosted that way
stops polling and every workflow stalls silently. The worker therefore needs a process that stays
up, which is what `apps/backend/Dockerfile` produces.

## Before you start

Accounts, all free and none requiring a card:

- **GitHub** — Vercel and the container host both deploy from a repository.
- **Supabase** — hosted Postgres, auth, and storage.
- **Vercel** — Hobby plan.
- **A container host** — see "Choosing a container host".
- **An uptime pinger** (for example cron-job.org) — only needed on a host that sleeps idle services.

Already configured in this repository's `.env` and reused as-is: Temporal Cloud, OpenAI, Composio.

## 1. Supabase

Create a project, then from the repository root:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` applies all 14 migrations. That includes `0014_storage_and_seed_support.sql`, which creates
the four storage buckets and their policies — there is no separate bucket-creation step, and none
should be added, because a bucket created by hand is a bucket no other environment has.

Then seed the demo data. Point the ops environment at the hosted project and run the same script
used locally:

```bash
SUPABASE_DB_URL='<pooler connection string>' \
NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<service role key>' \
pnpm seed
```

The seed creates the demo users, the whiteboard, its frozen spec, and the active agent versions. It
is idempotent: running it twice does not duplicate a board. It seeds one board per invocation, so
the second example needs its own run:

```bash
pnpm seed --board=examples/vendor-coi-renewal/board.seed.json
```

Two things about that command surprise people the first time.

It needs `NEXT_PUBLIC_SUPABASE_ANON_KEY` as well as the service-role key, because it signs in as the
demo user to exercise the same RLS path a browser would. Omit it and the key silently falls back to
whatever `.env` holds — the local stack's demo JWT — and the hosted project answers `Invalid API
key`.

It also runs each agent version's recorded validation command against the **committed** tree before
it will finalise that version. An uncommitted fix does not count, and a lint error anywhere in the
repository stops the seed. That is the release gate doing its job rather than a seeding bug.

Use the **session pooler** connection string, not the direct one. Supabase publishes
`db.<ref>.supabase.co` with an AAAA record and no A record, so the direct host is reachable only
from a network with IPv6. The pooler (`aws-0-<region>.pooler.supabase.com:5432`, user
`postgres.<ref>`) answers over IPv4 and works from anywhere.

### Row-level security and who can see anything

Access is per-owner throughout. A stranger who signs up gets a valid, completely empty account —
they will see no boards, no specs, no agents. **A demo link must therefore hand out the seeded demo
credentials** (`DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`) rather than invite people to register.

## 2. Web app on Vercel

Import the repository. Vercel detects the Next app and sets **Root Directory** to `apps/web`; leave
it there. Every command then runs from `apps/web`, which is why `apps/web/vercel.json` — the file
Vercel reads, given that root — says what it says. JSON cannot carry comments, so:

- `buildCommand` is `cd ../.. && pnpm build`, which is `tsc -b` followed by the Next build. The
  framework preset alone runs `next build`, and that fails here: the workspace packages are imported
  through subpath exports that point at `dist/*.js`, so nothing resolves until they are compiled.
  The output still lands in `apps/web/.next`, which is where Vercel already looks.
- `installCommand` also steps up to the root, because the lockfile and the workspace definition live
  there and the worker, the web app, and the packages are installed as one graph.
- `outputDirectory` is stated as `.next`, relative to the root directory, even though that is the
  default. It is stated because a project imported while a root-level `vercel.json` named
  `apps/web/.next` keeps that value as a saved project setting, and it is then applied _on top of_
  the root directory: Vercel looks in `apps/web/apps/web/.next`, finds nothing, and reports a
  missing output directory for a build that in fact succeeded. Naming it here overrides the stale
  setting, because `vercel.json` takes precedence over the dashboard.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set for the build, or installing the web app's dev
  dependencies fetches a browser the build never opens.

The first deploy is expected to fail or to produce a site that cannot sign in, because none of the
environment variables below exist yet. Add them, then redeploy.

Set the environment variables marked "web" in the table below. Note `WORKER_HEALTH_URL`: without it
the health endpoint probes `127.0.0.1`, which on Vercel is Vercel.

## 3. Worker on a container host

Build context is the repository root, not `apps/backend`:

```bash
docker build -f apps/backend/Dockerfile -t meridian-worker .
```

The image is about 1 GB and needs no arguments beyond environment variables. It listens on
`WORKER_HEALTH_PORT` and answers `GET /healthz` with the agent versions it has registered, which is
the one thing worth checking after any deploy: a worker that was not rebuilt after a generation run
will accept tasks it cannot serve, and this is where that shows.

### Choosing a container host

The constraint that eliminates most free tiers is that this service receives no HTTP traffic of its
own. Hosts that sleep idle services measure idleness in requests, and a worker quietly polling
Temporal looks idle to them.

- **Koyeb free** — one instance, 512 MB, 0.1 vCPU, 2 GB disk. Officially web-service-only, which the
  worker satisfies because it serves a health endpoint. It sleeps after one hour without traffic and
  that cannot be disabled on the free plan, so an external pinger against `/healthz` every ~50
  minutes is mandatory, not an optimisation. Set `WORKER_HEALTH_PORT` to the port the platform
  injects (8000 by default) and point its health check at `/healthz`.
- **Oracle Cloud Always Free** — genuinely always-on and far larger, but signup asks for a card for
  identity verification and the VM is set up by hand.

If the worker is killed for exceeding memory, that is the 512 MB limit; the image itself has been
run against the live Temporal Cloud namespace and needs roughly 200–300 MB at rest.

## 4. Environment contract

| Variable                                                             | Web | Worker | Notes                                                       |
| -------------------------------------------------------------------- | :-: | :----: | ----------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                           |  ✓  |   ✓    | `https://<ref>.supabase.co`                                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                      |  ✓  |        | Public by design; every table behind it is RLS-protected    |
| `SUPABASE_SERVICE_ROLE_KEY`                                          |  ✓  |   ✓    | Secret                                                      |
| `NEXT_PUBLIC_APP_BASE_URL`, `APP_BASE_URL`                           |  ✓  |        | The Vercel URL                                              |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`         |  ✓  |   ✓    | The web app starts and signals workflows, so it needs these |
| `TEMPORAL_TLS=true`, `TEMPORAL_TASK_QUEUE`                           |  ✓  |   ✓    | Must match on both sides or work is never picked up         |
| `WORKER_HEALTH_URL`                                                  |  ✓  |        | Public URL of the worker's `/healthz`                       |
| `WORKER_HEALTH_PORT`                                                 |     |   ✓    | Whatever the platform injects                               |
| `OPENAI_API_KEY`, `AI_MODE`, `AI_REVIEW_MODEL`                       |  ✓  |   ✓    | `AI_MODE=live` for real AI review                           |
| `COMPOSIO_*`                                                         |     |   ✓    | Tool calls happen in activities                             |
| `GMAIL_LIVE_MODE=false`                                              |     |   ✓    | See "Mock mode"                                             |
| `STORAGE_BUCKET_*`, `OCR_*`, `WORKER_MAX_*`, `AGENT_MAX_CONCURRENCY` |     |   ✓    | Defaults are fine                                           |
| `SUPABASE_DB_URL`, `DEMO_USER_*`, `EVAL_*`, `MERIDIAN_STATE_DIR`     |     |        | Local tooling only; not needed by either deployed service   |

## Mock mode

`GMAIL_LIVE_MODE=false` makes the mailbox tool read the `.eml` fixtures under `examples/` instead of
a real inbox. This is deliberate for a demo: the same eleven messages produce the same outcomes for
every reviewer, which a live mailbox cannot promise. The Composio code path is identical either way —
only the tool's source of messages differs — and the fixtures are baked into the image, which is why
`examples/` is excluded from `.dockerignore`'s exclusions.

## Verifying a deployment

In order, because each step depends on the one before:

1. `GET <worker-url>/healthz` returns `status: "ok"` and a non-empty `registeredVersions`.
2. `GET <web-url>/api/health` reports every component healthy, including the worker — this is the
   check that proves the two services can see each other.
3. Sign in with the demo credentials and confirm the seeded board, its frozen spec, and the active
   agent are all visible.
4. On the agent page, start a run from the fixture-mail panel and watch it reach a terminal outcome.
   That exercises the whole path: Vercel, Temporal Cloud, the worker, and Supabase.

## Known limits

- Eval runs stay CLI-driven (`pnpm evals`). The API only enqueues rows for the CLI to pick up, and
  it requires the caller to name the cases rather than discovering them on disk, because the
  deployed web service is not a checkout of the repository. There is deliberately no button for it:
  on a deployed link it would look like it worked and leave executions queued forever.
- A Supabase free project pauses after a week of inactivity. Open the dashboard before demoing.
- On a host that sleeps, the first request after an idle period waits a few seconds for a cold start.
