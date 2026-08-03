# Decisions

Choices that are not obvious from reading the code, and the reasoning behind each.

---

## Git rules

This repository is worked on by agents. The rules below exist so that an agent cannot destroy
history while trying to be helpful.

**Allowed:** `status --porcelain`, `add <explicit path>`, `commit`, `rev-parse`, `ls-tree`, `show`,
`diff --cached`, `log`.

**Forbidden:** `reset --hard`, forced checkout, any history rewrite (`rebase`, `filter-branch`,
`commit --amend` on pushed work), and `push`. Commits are local only.

`git add` is always called with explicit paths. `agent:finalize` goes further: it computes an
allow-list of exactly the five generated files plus the registry, stages only those, and then reads
back `git diff --cached --name-only` and refuses if anything outside the list is staged. A `git add
.` that swept in an unrelated edit would produce a commit whose SHA is recorded as "the code that
produced this execution" while containing changes nobody reviewed.

### The `sha1` object format

The repository is initialized with `git init --object-format=sha1 --initial-branch=main`, explicitly
rather than by default.

`agent_versions.git_commit_sha` is constrained to `^[0-9a-f]{40}$`. That constraint is only sound if
commit IDs are SHA-1. Git's SHA-256 object format produces 64-hex IDs, and a repository created with
it would fail the constraint at the first `record_agent_commit` — with an error about a check
constraint, which is a confusing way to learn that your object format is different. `lib/git.ts`
asserts the format at startup so the failure names the real cause.

---

## The twelfth table

The baseline PRD describes eleven tables. There are twelve.

`execution_actions` is the addition. The baseline modelled external effects as a field on the step,
which cannot express the state a system is in after it has asked Gmail to send something and has not
yet heard back. That state — _dispatched, outcome unknown_ — is the single most important state in
the whole design, because it is the one where a naive retry sends a second email to a customer. It
needs its own row with its own lifecycle, its own idempotency key, its own marker token, and its own
reconciliation evidence.

Making it a table also makes the invariants enforceable. `dispatched → reserved` can be forbidden by
a trigger. A reconciliation without evidence can be rejected by a check constraint. As a JSON field
on a step, all of that would have been convention.

---

## Approval does not activate

`transition_agent_version(... 'approved')` sets a status. It does not touch
`agents.active_agent_version_id`. Activation is a separate, explicit `activate_agent_version` call.

This looks like an oversight often enough to be worth writing down: it is deliberate. Approval means
"this version passed its evals and a human reviewed it". Activation means "this version now handles
production traffic". Those are different decisions, frequently made by different people at different
times, and collapsing them means a version goes live the instant someone clicks Approve.

The corollary is that an agent can have several approved versions and no active one, and the UI says
so plainly rather than silently resolving "the newest approved". Intake refuses to run an agent with
no active version rather than guessing, because guessing would bypass the gate that activation
exists to be.

---

## The omitted `(execution_id, step_instance_key)` index

Not created, on purpose.

`uq_execution_steps_instance_attempt` is `UNIQUE (execution_id, step_instance_key, attempt_no)`. A
b-tree on those three columns already serves any query whose predicate is a prefix — including
`WHERE execution_id = $1 AND step_instance_key = $2`, which is the "latest attempt for this instance"
lookup the UI does. A separate two-column index would be a strict subset of an index that already
exists: extra write cost on every step insert, extra pages in cache, and nothing gained.

---

## `output_summary_json.resultKind`, not `outcome`

`ck_executions_manual_review_has_no_workflow` states that a row whose
`output_summary_json->>'outcome'` is `manual_review` must have a null `temporal_workflow_id`. It
exists to guarantee that the intake no-key path never has a workflow.

But an agent running inside a workflow can also legitimately conclude `manual_review` — an unreadable
document, a missing commercial invoice, a case the spec does not decide. Written naively, those
completions would violate a constraint intended for something else entirely.

The resolution keeps the constraint exactly as specified and makes the key names mean what the
constraint's comment says:

- `output_summary_json.outcome` is written **only** by `create_manual_review_intake_execution`, which
  by definition has no workflow.
- Workflow and eval completions write `output_summary_json.resultKind`, alongside the full decision
  and bounded counts.

Readers check `resultKind` first and fall back to `outcome`. No constraint was weakened, no RPC was
altered, and the invariant is now precisely the one the comment claims.

---

## `pnpm dev:infra` returns; it does not block

Starting Supabase and Temporal is a command that finishes. Temporal is spawned detached, with its
output redirected to `.meridian/temporal.log`.

The alternative — holding a terminal for the duration — means a developer who wants to run the test
suite needs a second terminal, and the first thing anyone does is background the process in a way
that nothing can later find or clean up. So the project owns the lifecycle explicitly: the PID goes
in `.meridian/dev-infra.json` along with a random cookie written to `.meridian/temporal.pid`.

`pnpm stop` will not signal a PID unless the recorded PID is alive, its `ps` command line matches
`temporal server start-dev`, **and** the cookie matches. Operating systems reuse PIDs, and a stale
record can name something entirely unrelated; a `kill` on a recycled PID is the kind of bug that
destroys someone's afternoon. Supabase is stopped through `supabase stop`, which is scoped to this
repository's `config.toml`, so another local stack on the same machine keeps running.

This detached process is the only one in the system. Application work never escapes an HTTP request:
the review route is fully awaited, and the eval suite is a CLI rather than a background task.

---

## Reviews are synchronous; evals are not

`POST /api/whiteboards/:id/reviews` performs the entire round and returns the terminal result. The
button spins for as long as the model takes.

A Next.js route handler that returns before its work finishes has no guarantee the remaining work
runs at all. For a review that matters: `create_review_session` inserts a `running` row behind a
unique index on active sessions, so a round that dies silently leaves the board unable to start
another one, forever, with no error anywhere. Awaiting it means a failure is a failure — the
`finally` calls `fail_review_session`, and the user sees a 502 instead of a spinner that never
resolves.

The eval suite is genuinely long-running — fifteen cases against a real database — so it is a CLI
command, not a request. `POST /api/eval-runs` accepts and returns 202 with the exact command to run.
The route does **not** shell out, because a web request that spawns a build is a web request that can
be cancelled halfway through a commit.

---

## Generation is operator-invoked

No HTTP route invokes Cursor or Codex. `POST /api/agents/:id/version-reservations` reserves a version
row and returns the `/goal` command as a string for the operator to run.

Pretending otherwise would be the most tempting shortcut in the project and the most dishonest. The
generation step needs a coding agent with repository write access and a human watching it; a route
that appeared to do that would either be lying or would be handing arbitrary code execution to
whoever can reach the endpoint.

---

## `spec_hash` covers the contract, not the circumstances of the freeze

The hash is taken over a _semantic view_ of `spec_json`, which holds out five fields:
`identity.specId`, `identity.specVersion`, `source.frozenAt`, `source.reviewSessionIds`, and the two
acknowledgement flags. Everything else — the board, the name, the canvas hash and revision, the
process, data, policies, capabilities, outputs, assumptions, known gaps, acceptance criteria — is in.

Hashing the held-out fields would have made every hash unique by construction. A fresh UUID and a
clock reading differ between two freezes of a board nobody touched, so `UNIQUE (spec_hash)` would
never fire, `SPEC_ALREADY_FROZEN` would be unreachable, and two agent versions built from one
agreement would look as though they were built from two. The question `spec_hash` answers is "is this
the same contract", and which review sessions happened to look at the board, or what the operator
waved through on the day, is not part of the answer. All of it is still recorded in the stored
`spec_json` and is still readable; it is only kept out of the identity.

The canvas hash is derived the same way, minus `metadata.status`: freezing moves a board from `draft`
to `submitted`, and a hash recorded before that has to survive it.

---

## The example board names its own UUID

`meridian.seed_whiteboard_graph` takes the board ID from the fixture when it supplies one, exactly as
it already takes every node and edge ID.

The canonical snapshot carries `metadata.whiteboardId`, which means the board ID is hashed. With a
server-assigned ID, seeding the same fixture on two machines would produce two canvas hashes and two
spec hashes, and the `spec.snapshot.json` committed beside the generated agent could not correspond
to any freeze except the one that happened to produce it — which would make `pnpm demo` and
`pnpm verify:e2e` unable to check the artifact they are demonstrating. With a fixture-supplied ID,
`pnpm seed`, a review, rejecting the findings, and a freeze reproduce the committed hash exactly, and
`pnpm verify` recomputes it from the board on every run.

---

## Fixtures are committed, and also generated

`examples/**` is checked in — boards, `.eml` files, PDFs, eval cases, expected documents — and
`packages/ops/src/fixtures/` can regenerate all of it deterministically.

Generating at test time would defeat the purpose. A fixture built by the same code under test moves
whenever that code moves, so it can never catch a regression in the canonicalizer, the compiler, or
the agent's policy. Committing the output makes every change to it a reviewable diff. Keeping the
generator makes that output reproducible and reviewable rather than mysterious.

---

## The eval harness does not go through Temporal

`packages/evals` runs the identical `AgentDefinition` against the identical `ExecutionRecorder`,
writing to the real database — but calls `definition.run()` directly instead of through a workflow.

A durable-execution round trip per case would make the suite slow enough that nobody runs it, and it
would mostly be testing Temporal. The properties that genuinely depend on Temporal — replay
determinism, signal handling, action reservation surviving a crash — are covered by
`pnpm test:temporal` with `TestWorkflowEnvironment`, which is the right tool for them.

What the harness does supply is determinism: a fixed clock at a pinned epoch, a mailbox restricted to
the case's own declared messages, and a fixture-driven document tool. Two runs of a green suite
produce identical rows apart from identifiers.

---

## `packages/ops`, not `scripts/`

Every operator command is a module in `packages/ops` with `scripts/<name>.ts` as a three-line alias.

Code in `scripts/` is outside the build graph: it is not typechecked by `tsc -b`, not covered by
`pnpm test:unit`, and not linted with the project's type-aware rules. That is acceptable for a
one-liner and unacceptable for port classification, Git object verification, process ownership, and
the eval runner — the exact code whose failure modes are hardest to debug. Putting it in a workspace
package means `pnpm typecheck`, `pnpm build:ts`, and `pnpm test:unit` all cover it, and
`verify-tree` asserts that `scripts/` contains nothing but aliases.

---

## Recorded versions are concrete, never `latest`

`COMPOSIO_GMAIL_TOOLKIT_VERSION=latest` is legal as _input_. `pnpm preflight` resolves it and writes
the concrete value to `.meridian/resolved-versions.json`, and that concrete value is what goes into
`manifest.json` and into execution metadata.

A recorded `latest` makes the lineage a lie. The whole promise of pinning a Git SHA is that you can
re-read exactly what ran; if the manifest beside it says the toolkit was `latest`, the same SHA means
something different next week. `BuildManifestSchema` rejects the literal, `agent:finalize` rejects
it, and `pnpm verify` greps for it.

---

## Intake asks Temporal whether a run is open

Correlation intake calls `describe(workflowId)` before it decides anything, rather than reading
`status` from the latest `executions` row.

The row is written by the workflow and the run is closed by the server, and those are two events
with a gap between them. An intake that reads the row inside that gap concludes the case is over,
creates a new execution, and then watches `signalWithStart` deliver its message to the old run under
`USE_EXISTING` — because the old run is, in fact, still open. The new row is then named by no
workflow. It is not queued, not running anywhere, and nothing will ever finish it. This is not a
hypothetical: it is what produced the second stuck `running` row in the demo, reproducibly, whenever
two messages for one container arrived close together.

The cost is one extra RPC per message. The alternative designs are worse: locking the workflow ID
across the read and the write serialises intake on the hottest path, and reconciling afterwards
means the orphan exists — visible in the executions list, indistinguishable from a real hang — until
a sweep notices. Asking the party that actually knows is both cheaper and honest.

Terminating an unclaimed run follows from the same principle in reverse. If Temporal has a run open
and the database has no row for it, the database is right and the run is the anomaly, because every
write that run attempts will fail against a foreign key. The grace period exists only to avoid
racing an intake that has started a run and not yet recorded its ID.

---

## A live row is the case, even before its run exists

Asking Temporal is necessary and not sufficient. Between the moment the winning intake writes its
`executions` row and the moment it reaches `signalWithStart` there is no open run and no finished
one, and an intake that treats "no run open" as "no case in progress" concludes it should start a
new case. It then computes a follow-up case key, attempts a second live row for the same workflow
ID, and is refused by `uq_executions_active_workflow`. Two messages for one container arriving
together failed this way about one time in five.

So the row and the server answer different questions, and both are asked. A `queued` or `running`
row is the case by construction — the unique index reserves exactly those two statuses, so while
such a row exists there is no second row to be had and joining it is the only insert that can
succeed. Temporal is then asked about the case the row says is _over_, which is the window the
previous decision describes.

The same race has a second half inside `create_execution`. Its `on conflict (idempotency_key)`
names one arbiter, but an insert is checked against every unique index on the table, and a
collision on a non-arbiter index raises instead of resolving. Two callers with the _same_
idempotency key — the ordinary duplicate — therefore surfaced as a raw constraint error from the
active-workflow index. The RPC now re-reads the row the other caller wrote, and still re-raises
when nothing exists under that key, because then the refusal is the constraint correctly telling a
genuinely different case that this workflow already has a live run. The index was not relaxed;
what changed is that a duplicate is answered rather than thrown.

This was invisible for as long as it was because the Temporal test double reported `RUNNING` for a
workflow that had never been started. The ordinary first-message path never took the branch it
takes against a real server. A double that is wrong in a convenient direction is worse than no
double, and this one now raises `WorkflowNotFoundError` for an unknown ID exactly as the client
does.

---

## Redelivery is detected from an ingest log, not from the case key

Intake appends `message:ingested:<providerMessageId>` for every message it correlates, and consults
that log before creating anything.

The case key was the obvious candidate and it cannot work. The first message of a case gets
`live:<KEY>`; a message that arrives after the case closed gets
`live:<KEY>:followup:<providerMessageId>`. That distinction is deliberate and correct — a late
packing list should open a new case rather than mutate a closed one — but it means the redelivery of
a first message and the arrival of a new document are the same shape to the key. Guessing wrong in
one direction drops a real document; guessing wrong in the other re-runs a shipment, and re-running
a shipment re-sends every email the first run sent. Neither is acceptable, so the question is
answered from a record of what was actually taken in.

Logging after `start_execution` rather than before is deliberate: an ingest that is recorded is one
that provably reached a workflow. The write is also non-fatal — losing it costs a redelivery check,
not the run — so a failure there is logged and swallowed rather than surfaced as a lost message.

---

## The external gates are reported, never enforced

`pnpm gates` names the four verifications that need a credential this repository cannot contain,
says which of them can run here, and exits 0 either way. `pnpm verify` prints the same report as a
step.

Failing when a key is absent would be the obvious alternative and it is wrong twice over. It makes
the absence of a credential look like a defect in the code, and it puts `pnpm verify` permanently
red on precisely the machine the README is written for — which trains the reader to ignore the one
signal the suite exists to give. The opposite failure is worse still: staying silent lets an
all-green summary imply that the live paths were exercised, when what actually happened is that
nobody checked.

So the report is unconditional and the wording is blunt. `NOT RUN` is not a warning to be cleared;
it is the accurate description of a claim this run did not test, printed next to the exact command
that would test it.

The same reasoning shapes the live model smoke. It is **declared only when its credentials are
present**, rather than declared and skipped — `pnpm verify` bans `.skipIf` outright, because a
skipped test reports success without running, and a gate whose absence is invisible is not a gate.

---

## The model boundary is not a registered activity

Structured extraction is real, non-deterministic I/O, so it has to happen inside an activity. It
does: an agent asks for fields through `DocumentTool.extractFields`, which the workflow reaches via
the `documentExtractFields` activity, which calls `modelExtractStructured` in
`apps/backend/src/temporal/activities/model.ts`. That function is _not_ registered in the activity
map, because no proxy invokes it directly and a registration nothing calls advertises a durable
operation that does not exist.

It was registered at first, and the cost showed up immediately. The plan enumerates `model.ts`
among the activity files while its own `ToolRegistry` has exactly four members and no model tool —
so the file was created with nowhere to be called from, and the extraction that agents actually
perform was written a second time, inline, in `createTools`. Two implementations of one OpenAI call,
already disagreeing about reasoning effort, neither one wrong enough to fail.

The single implementation now lives in `model.ts` and is injected into `createTools`, which is where
`createLiveDocumentTool` already expected to receive it. `agent-kit` keeps its property that
importing it never pulls a model SDK toward a mock run. `workflow-boundary.test.ts` asserts that
every registered activity is called by workflow code, which is the check that would have caught the
duplicate on the day it was written.

## Cold-start success contract

A clean checkout is verified when, running only the commands in `README.md` in order:

1. `pnpm preflight` passes and `.meridian/resolved-versions.json` holds a concrete toolkit version.
2. `pnpm install --frozen-lockfile` succeeds against the committed lockfile.
3. `pnpm build` completes, including `next build`.
4. `pnpm dev:infra` returns — it does not block — and `pnpm health` reports Supabase and Temporal ok
   with the worker and web not yet started.
5. All fourteen migrations apply from `pnpm db:reset`, `pnpm db:types` produces no diff, and
   `pnpm seed` creates the demo users and the example board.
6. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:db`, and
   `pnpm test:temporal` all exit 0.
7. With `pnpm dev` running in its own terminal, `pnpm health` is green on all four,
   and `pnpm test:service`, `pnpm test:component`, and `pnpm test:e2e` exit 0.
8. `pnpm verify`, `pnpm verify:e2e`, and `pnpm demo` exit 0.
9. `pnpm stop` leaves any Supabase stack this project did not start still running.

Only `pnpm dev` blocks. No step depends on a shell state left behind by a previous step.
