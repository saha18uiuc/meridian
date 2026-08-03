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
| 7233        | Temporal server                           |
| 8233        | Temporal Web UI                           |
| 9464        | Worker health endpoint                    |
| 54521       | Supabase REST/auth                        |
| 54522       | Postgres                                  |
| 54523       | Supabase Studio                           |
| 54524       | Inbucket (mail catcher)                   |
| 54525–54527 | Supabase analytics, storage, edge runtime |

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

`pnpm verify` includes `next build`. A broken server component fails verification rather than
surfacing at deploy time.

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
examples            The seeded boards, message and document fixtures, and 15 eval cases
supabase            14 migrations, seed, storage policies
docs                PRD, architecture, decisions, demo walkthrough
```

Read `docs/ARCHITECTURE.md` for how the pieces fit, `docs/DECISIONS.md` for the choices that are not
obvious from the code, and `docs/DEMO.md` for the walkthrough.
