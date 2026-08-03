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
