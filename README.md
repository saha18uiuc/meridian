# Meridian

A whiteboard where you draw a business process, argue with a model about it, freeze the result, and
then generate a real agent that runs it — with every execution traceable back to the exact drawing,
the exact specification, and the exact commit it came from.

The worked example is **Inbound Import Receiving**: a freight forwarder emails a container number
and a pile of PDFs; the agent correlates the documents to a shipment, checks five regulatory fields
on every product line and one certificate of analysis per batch, and then either marks the shipment
ready, asks for exactly what is missing, rejects it, or hands it to a person.

---

## Prerequisites

| Tool         | Version    | Install                                                       |
| ------------ | ---------- | ------------------------------------------------------------- |
| Node         | 22.16.0    | `nvm install` (the repository has a `.nvmrc`)                 |
| pnpm         | 10.32.1    | `corepack enable && corepack prepare pnpm@10.32.1 --activate` |
| Docker       | any recent | Docker Desktop, running                                       |
| Supabase CLI | 2.110.0+   | `brew install supabase/tap/supabase`                          |
| Temporal CLI | 1.8.2      | `brew install temporal`                                       |

No paid API key is required. Every verification command below passes against deterministic mocks.
`OPENAI_API_KEY` and the Composio Gmail credentials unlock two optional live paths and nothing else.

## Ports

`pnpm preflight` checks all eleven and classifies each as free, owned by this project, or foreign.
It never kills anything, and it deliberately ignores Supabase's default 54321 so a second local
stack on this machine is left alone.

| Port        | Service                                   |
| ----------- | ----------------------------------------- |
| 3000        | Next.js                                   |
| 7233        | Temporal server (local dev server only)   |
| 8233        | Temporal Web UI (local dev server only)   |
| 9464        | Worker health endpoint                    |
| 54521       | Supabase REST/auth                        |
| 54522       | Postgres                                  |
| 54523       | Supabase Studio                           |
| 54524       | Inbucket (mail catcher)                   |
| 54525–54527 | Supabase analytics, storage, edge runtime |

## Temporal: Cloud or the local dev server

Which Temporal this repository talks to is an environment change and nothing else. There is no
Cloud branch in the code and no build flag: all five places that open a connection — the worker, the
backend client, the ops CLI, the web intake path, and the health route — derive it from
`temporalTarget()` in `packages/core/src/env.ts`, so the target is decided in one place from four
variables.

```bash
# Temporal Cloud, API key authentication. With an API key the endpoint is the *regional* gRPC one,
# not a per-namespace host; older mTLS-style namespaces use <namespace>.<account>.tmprl.cloud:7233.
TEMPORAL_ADDRESS=us-west-2.aws.api.temporal.io:7233
TEMPORAL_NAMESPACE=<namespace>.<account>     # the account suffix is required
TEMPORAL_API_KEY=<key>                       # implies TLS on its own
TEMPORAL_TLS=true
TEMPORAL_UI_URL=https://cloud.temporal.io/namespaces/<namespace>.<account>

# The local dev server, for offline work. Clearing the key is what switches back.
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_API_KEY=
TEMPORAL_TLS=false
TEMPORAL_UI_URL=http://127.0.0.1:8233
```

Nothing else changes, and in particular nothing needs to remember to stop starting a server:
`ownsLocalTemporal()` reads the same configuration and tells `pnpm dev:infra` whether this machine
is responsible for a dev server. Pointed at Cloud it reports `temporal remote … nothing to start
here`, leaves port 7233 unbound, and `pnpm health` probes the Cloud namespace instead. That property
is the difference between using Temporal and being able to deploy this.

The namespace this repository is currently configured against is Meridian-provisioned, in
`us-west-2` on AWS, with **an API key that expires 2026-09-03**. After that date every Temporal call
fails to authenticate until the key is rotated in `.env`; the dev server block above needs no
credential and keeps working regardless. `pnpm test:temporal` is unaffected either way — it runs its
own ephemeral time-skipping server and never reaches the configured target.

## Cold start

Every command here terminates on its own **except `pnpm dev`**, which is the one blocking command
and belongs in its own terminal. Nothing after it assumes a continuing shell.

```bash
# 1. Prerequisites, once
corepack enable
corepack prepare pnpm@10.32.1 --activate
brew install temporal

# 2. Preflight: ports, Docker, credential presence (never values), and resolution of external
#    tool versions into .meridian/resolved-versions.json so nothing ever records "latest"
pnpm preflight
cat .meridian/resolved-versions.json

# 3. Install and build
pnpm install --frozen-lockfile
pnpm --filter @meridian/web exec playwright install chromium
pnpm build                        # build:ts across every project, then next build

# 4. Infrastructure — returns, does not block
pnpm dev:infra
pnpm health                       # supabase ok, temporal ok, worker/web not-started

# 5. Database
pnpm db:reset
pnpm db:types
pnpm seed

# 6. Static and unit gates
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit

# 7. Database and Temporal gates
pnpm test:db
pnpm test:temporal

# 8. Application processes — terminal A blocks here
pnpm dev
#    …and in terminal B:
pnpm health                       # now all four green
pnpm test:service
pnpm test:component
pnpm test:e2e

# 9. Agent generation, operator in the loop
pnpm agent:reserve --whiteboard "$BOARD_ID" --deployment inbound-import-receiving
#    prints the exact /goal command; run it in Cursor or Codex
pnpm agent:export-spec --agent-version "$AGENT_VERSION_ID"
#    the spec-to-agent skill writes the five files
pnpm agent:finalize --agent-version "$AGENT_VERSION_ID"
pnpm agent:verify-manifest --agent-version "$AGENT_VERSION_ID"

# 10. Evals and scale
pnpm evals --agent-version "$AGENT_VERSION_ID"
pnpm test:scale
pnpm test:multi-agent

# 11. Full verification and demo
pnpm verify
pnpm verify:e2e
pnpm demo

# 12. Teardown
pnpm stop
```

`pnpm bootstrap` runs steps 2 and 3 in one go for a fresh checkout.

## Verification

| Command            | What it proves                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`      | Lint, format, typecheck, `build:ts`, `next build`, the repository tree, unit, database, and Temporal suites, plus every source audit. Needs Supabase running. |
| `pnpm verify:e2e`  | Everything that needs a live stack: reset, seed, service and component suites, the mock demo, Playwright, and a health read.                                  |
| `pnpm demo`        | The end-to-end mock demo, run as assertions rather than as output to read.                                                                                    |
| `pnpm verify:tree` | Every required path exists and no undeclared file has crept in.                                                                                               |
| `pnpm gates`       | Which external gates can run here, and which are reported unverified. Never fails.                                                                            |

`pnpm verify` includes `next build`. A broken server component fails verification rather than
surfacing at deploy time.

## External gates

Four claims cannot be proven from this repository alone, because they need a credential it must not
contain. `pnpm verify` prints their status on every run and `pnpm gates` prints it on demand, so a
green summary never implies the live paths were exercised.

| Gate                        | Needs                                                                 | Command                                                |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Real-model review           | `OPENAI_API_KEY`                                                      | `AI_MODE=live pnpm test:service -t "live model smoke"` |
| Composio OAuth consent      | `COMPOSIO_API_KEY`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`                   | `pnpm connect:gmail`                                   |
| Live Gmail fetch and send   | the above, plus `GMAIL_LIVE_MODE=true` and `GMAIL_ALLOWED_RECIPIENTS` | `GMAIL_LIVE_MODE=true pnpm process-inbox --once`       |
| Operator-invoked generation | nothing; the operator runs the skill                                  | step 9 above                                           |

To enable the live paths, add the keys to `.env` and re-run `pnpm preflight`. That is what resolves
`COMPOSIO_GMAIL_TOOLKIT_VERSION=latest` to a concrete published version and rewrites
`.meridian/resolved-versions.json`; without a Composio key it records `mock`, and no execution ever
records the literal string `latest`. `pnpm connect:gmail` prints a consent URL and then the exact
`COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID=` line to paste back.

`GMAIL_LIVE_MODE` is a hard switch, not a hint: every send and draft throws before contacting
Composio while it is false, and even when true a recipient outside `GMAIL_ALLOWED_RECIPIENTS` is
refused. The live smoke is the only test in the suite that spends money, and it is declared only
when its credentials are present — not declared and skipped, because a skipped test reports success
without running.

## Reset

```bash
pnpm stop                              # stops only what this project started
pnpm db:reset                          # re-applies all 14 migrations and the seed
rm -rf node_modules .next dist .meridian .temporal   # full cold start
```

`pnpm stop` proves ownership before signalling: it matches the recorded PID against both the process
command line and a cookie written at startup, so a recycled PID belonging to something else is never
touched. A Supabase stack this project did not start keeps running.

## Layout

```
apps/web            Next.js App Router: canvas, review, spec, agents, executions, 24 API routes
apps/backend        Temporal worker, workflows, activities
packages/core       Hashing, the compiler, review reconciliation, schemas, env contract
packages/agent-kit  The contract surface generated agents see, plus tools and recording
packages/evals      The eval harness: cases, assertions, classification, reports
packages/ops        Every operator command; `scripts/` holds three-line aliases only
generated-agents    Committed generated agent versions and the static registry
examples            Two seeded boards, their mail and document fixtures, and 21 eval cases
supabase            14 migrations, seed, storage policies
docs                PRD, architecture, decisions, deliverables index, demo walkthrough
```

Read `docs/DELIVERABLES.md` for where each thing the assignment asks for lives,
`docs/ARCHITECTURE.md` for how the pieces fit, `docs/DECISIONS.md` for the choices that are not
obvious from the code, and `docs/DEMO.md` for the walkthrough.
