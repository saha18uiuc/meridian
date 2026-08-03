# Architecture

How the pieces fit, and why each boundary is where it is.

---

## The write path

There is exactly one way to change a board, and it is not the one you would get by default.

The browser holds an anon or authenticated Supabase session. Those roles can `SELECT` the rows they
own in `whiteboards`, `whiteboard_nodes`, and `whiteboard_edges`. They cannot `INSERT`, `UPDATE`, or
`DELETE` any of the three — the privileges are revoked and no write policy exists. This is stronger
than "the UI doesn't do that": a client that constructs its own PostgREST call still cannot write a
`revision_no`, a `row_version`, a `last_reviewed_revision_no`, or a `status`.

Every change goes through a `SECURITY DEFINER` RPC that runs as one transaction:

```
save_whiteboard_delta(whiteboardId, expectedRevisionNo, nodeUpserts, nodeDeletes,
                      edgeUpserts, edgeDeletes, viewport)
  → { revisionNo, nodeRowVersions, edgeRowVersions, changed }
```

Inside, the order is fixed and the failure mode is all-or-nothing:

```
verify ownership  →  lock the board FOR UPDATE  →  check expected_revision_no
   →  validate the payload shape
   →  node upserts  →  edge upserts  →  edge deletes  →  node deletes
   →  viewport  →  revision_no += 1 (at most once)
```

Edges are deleted before nodes so a node delete never trips a foreign key on an edge that was going
away in the same delta. Each update carries the exact `row_version` it read; one mismatch aborts the
entire delta with `STALE_NODE_ROW_VERSION`, and nothing partial is committed. Two browsers editing
the same board therefore cannot interleave into a state neither of them intended — the second one
gets a conflict banner and refetches.

Even the service role cannot bypass this. A trigger on all three tables rejects direct
`INSERT`/`UPDATE`/`DELETE` unless a transaction-local flag set by the RPC is present. The trusted
path is trusted because it is the only path, not because the code that uses it is careful.

## Hashing and `jsonb`

`packages/core/src/hashing.ts` is the only implementation of canonicalization and hashing in the
repository. The review service, the freeze service, the eval harness, the manifest verifier, and the
tests all import it. Duplicating it would mean two definitions of "the same board", and the first
time they disagreed the disagreement would look like data corruption.

Canonicalization is RFC 8785 (JSON Canonicalization Scheme): keys sorted by UTF-16 code unit,
recursively; ECMAScript number serialization, so `1`, `1.0`, and `1e0` all become `1` and `-0`
becomes `0`; `NaN` and `±Infinity` rejected outright rather than coerced. On top of JCS, nodes are
sorted by ID and edges by ID before assembly, and set-like collections are sorted and de-duplicated
by the caller, so a different query plan cannot produce a different hash.

**What `jsonb` does to this.** PostgreSQL's `jsonb` is not a string. It discards whitespace and key
order, drops duplicate keys, and normalizes numeric literals through `numeric`. A value written as
`{"b":1,"a":1.0}` reads back as `{"a": 1.0, "b": 1}`. So nothing stored in `jsonb` is ever described
as byte-preserving, and **every** comparison re-canonicalizes both sides before hashing. That is why
`spec.snapshot.json` verification canonicalizes the committed file _and_ the database value rather
than comparing bytes: the bytes legitimately differ, and only the canonical forms are required to
match.

Hashes here identify content. They are not authentication. A matching hash proves two values are the
same value; it proves nothing about who produced either one.

## The workflow/activity boundary

`AgentDefinition.run` executes inside the Temporal workflow sandbox — a V8 isolate with no
filesystem, no network, no `process`, no real clock, and deterministic replay. Anything that touches
the outside world has to be an activity.

```
                     ┌─────────────── workflow sandbox ───────────────┐
  Temporal    ──────▶│  receivingWorkflow                             │
                     │    resolveAgent(AGENT_REGISTRY, key, versionNo)│
                     │    definition.run(input, context)              │
                     │      context.clock      → workflow.now()       │
                     │      context.toolRegistry → activity proxies ──┼──▶ activities
                     │      context.recorder     → activity proxies ──┼──▶ activities
                     └────────────────────────────────────────────────┘
                                                                        │
                                                    Supabase, Gmail, PDFs, browser
```

The registry is static and compiled into the bundle. There is no dynamic `import()` and no directory
scan, because neither works in the sandbox — so `generated-agents/index.ts` is generated with
top-level import statements, and adding a version means regenerating it and restarting the worker.
That restart requirement is a real operational hazard, so `pnpm health` compares what the worker
reports on `/healthz` against what the database says is active and flags any version that is active
but not bundled. Without that check the gap is invisible until an execution dies deep inside a
workflow.

Generated agents are held to the boundary by lint, not by convention: `generated-agents/**` may
import only `@meridian/agent-kit/contracts`, `zod`, and its own siblings, and may not call
`Date.now()`, `Math.random()`, or `setTimeout`. `@meridian/agent-kit` (the root entry) exports live
adapters and Supabase-backed recording for the worker's use, and importing _that_ from generated code
is an error for exactly the reason it looks convenient.

## Correlation intake

The hardest part of this system is not running a workflow. It is deciding _which_ workflow a message
belongs to, before any workflow exists.

```
message arrives
     │
     ├─ extract business key (ISO 6346 container / IATA MAWB, with check digits)
     │
     ├─ none or conflicting ──▶ create_manual_review_intake_execution
     │                            one terminal row, no workflow, evidence event, structured reason
     │
     └─ exactly one key
            │
            ├─ workflowId = receiving:<KEY>          (derived, not allocated)
            ├─ seen before, case closed? ──▶ already_processed, no row, no workflow
            ├─ describe(workflowId)                   (ask Temporal, do not infer from the row)
            ├─ create_execution                       (idempotent on idempotency_key)
            ├─ client.workflow.signalWithStart(...)   (start-or-signal, atomic, server-side)
            ├─ start_execution(runId)                 (retried; sweeper repairs if it fails)
            └─ append message:ingested:<providerMessageId>
```

`signalWithStart` is the whole design. The obvious implementation — try `start`, catch
`WorkflowExecutionAlreadyStartedError`, then `signal` — has a window between the catch and the signal
in which the workflow can complete, and the signal then lands on nothing. `signalWithStart` makes the
Temporal server do both atomically, so there is no start attempt to fail and no window to lose.

The ordering is also deliberate: the `executions` row is written **before** Temporal is told
anything. The one irrecoverable arrangement is a running workflow that no row names, and writing the
row first makes it impossible. The reverse failure — a row in `queued` whose run ID never got
persisted — is recoverable, and `reconcile-queued-executions` recovers it by re-describing the
workflow and replaying `start_execution`, which is a no-op that returns `wasAlreadyStarted`.

**Liveness is read from Temporal, not from the row.** Before deciding whether a message joins an
open case or opens a new one, intake calls `describe(workflowId)`. The row and the server disagree
for a real interval — between a workflow writing its terminal status and its run actually closing —
and a decision made from the row alone lands in exactly that window: intake reads "finished",
creates a second execution, and `signalWithStart` hands the message to the still-open run under
`USE_EXISTING`. That run is carrying the _previous_ execution ID, so the row just created is named
by nothing and sits in `running` forever. Three rules follow from asking the server instead:

- A run that is open and is the run the latest row names is joined as it stands. Recomputing a case
  key here would try to insert a second live row for one workflow, which
  `uq_executions_active_workflow` forbids.
- A run that is open and that no known row names is given a bounded moment to settle
  (`RUN_SETTLE_ATTEMPTS × RUN_SETTLE_INTERVAL_MS`), then re-read. A concurrent intake that has
  started a run but not yet recorded its ID resolves itself in that window.
- A run still unclaimed after `RUN_ADOPTION_GRACE_MS` is terminated. It has nowhere to report:
  every step it writes points at an execution row that does not exist. Locally this is what
  `supabase db reset` leaves behind, because the Temporal dev server keeps its own store; in
  production it is the shape of a restore from a backup taken before the run started.

**Redelivery is answered from an ingest log, not from the case key.** Every correlated message
appends `message:ingested:<providerMessageId>` to `execution_events` after its run ID is recorded.
When that key already exists and the execution it belongs to is terminal, intake returns
`already_processed` and does nothing else. The case key cannot answer this question: a first message
and a late follow-up are given different case keys by design, so a redelivery of the first message
after the case closed is indistinguishable from a genuinely new document — and re-running a shipment
re-sends everything the first run sent. The log also happens to be the only durable answer to "which
messages is this case made of", which is otherwise visible only inside Temporal history.

The sweeper covers the same ground from the other side. `reconcile-queued-executions` reads both
`queued` and `running` rows: a `queued` row whose run exists gets its run ID; a `running` row whose
run has closed is completed or failed to match; a `running` row whose run belongs to a different
execution is failed, because it has been superseded and will never report.

## The external-action protocol

Every effect the outside world can observe is a three-phase state machine:

```
reserved ──▶ dispatched ──▶ succeeded
    │            │      └──▶ failed
    │            └────────▶ needs_reconciliation ──▶ succeeded
    │                                             ├──▶ reserved   (requires proof of non-delivery)
    └──────────────────────────────────────────────┴──▶ abandoned
```

The provider call happens strictly between `dispatchAction` and `completeAction`. That gap is not
overhead — it is the only interval in which the system can later determine whether a send escaped.
A process that dies leaves the row in `dispatched`, which is unambiguous: _we asked, we do not know
the answer._

**`dispatched → reserved` does not exist.** The only route back to `reserved` runs through
`needs_reconciliation` and requires positive evidence of non-delivery recorded in
`reconciliation_json`. This is the difference between a system that retries and a system that double-
sends.

**The honest claim.** Gmail accepts no client-supplied idempotency token. There is no way to ask it
to send-at-most-once. So the adapter appends `[meridian-ref: <token>]` to the body, and
reconciliation searches the mailbox for that token. Replay deduplication — the same workflow
replaying the same step — is exact, guaranteed by the derived idempotency key and a unique index.
External delivery is **best-effort**: when reconciliation cannot conclude safely, the action ends
`needs_reconciliation` or `abandoned`, the workflow escalates, and a person sees the pending action
in the UI. Nothing is ever resent blindly. Anywhere the words "exactly once" appear in this codebase,
they are qualified, and `pnpm verify` greps for the unqualified claim.

## Steps, events, and identity

`execution_steps` has two ordering-ish columns and they mean completely different things.

`step_instance_key` is **logical identity**: which step this is, in a way that survives retries. Two
attempts at the same logical step share the key and differ by `attempt_no`, and
`(execution_id, step_instance_key, attempt_no)` is unique. The UI groups by it to show "attempt 2 of
3" instead of three unrelated rows.

`sequence_no` is **display ordering** and nothing else. It is not unique, it is not identity, and
nothing joins on it. Parallel steps legitimately share one. Every query that means "this step" uses
the instance key; every query that means "in what order do I show these" uses the sequence number.

`execution_events` is append-only, enforced by a trigger that rejects `UPDATE` and `DELETE` for every
role including `service_role`. Evidence carries an optional `event_key` that makes it idempotent
across replays, so a workflow replaying a step does not accumulate duplicate evidence.

## Scaling

The normalized graph is the reason a hundred-node board is unremarkable. A card move writes one row
and bumps one revision; it does not rewrite the graph. `pnpm test:scale` saves, reviews, and freezes
a 101-node board to keep that honest.

Snapshots are taken only at review and freeze boundaries — two immutable JSON blobs per round, not
one per keystroke. Execution storage is bounded on purpose: `execution_steps` and `execution_events`
hold summaries and references, never raw documents, which live in Supabase Storage under a path the
event points at.

The worker bounds concurrency at three levels: `WORKER_MAX_CONCURRENT_WORKFLOWS`,
`WORKER_MAX_CONCURRENT_ACTIVITIES`, and `AGENT_MAX_CONCURRENCY` for fan-out inside a single run, so
one large shipment cannot starve the queue.

## Multi-agent lineage

Two logical agents can share one whiteboard. Their version numbering is independent, allocated under
a lock per agent, and their release pointers move independently.

```
whiteboard ─┬─ frozen_spec v1 ─┬─ agent A ─┬─ version 1 (approved, active)
            │                  │           └─ version 2 (evaluating)
            │                  └─ agent B ─── version 1 (approved, active)
            └─ frozen_spec v2 ──── …
```

Executions pin `agent_version_id`, and through it the spec hash and the Git SHA. Rolling back is
activating an earlier approved version; it changes which version _new_ runs resolve to and rewrites
nothing about runs that already happened. An execution from last week still reports the version, the
spec hash, and the commit it actually ran under, which is the entire point of pinning.
