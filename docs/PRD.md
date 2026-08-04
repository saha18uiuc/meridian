# Meridian — Final Amended Normative Contract

This is the contract the system is built against. Where it differs from the baseline PRD, **this
document governs** and the difference is recorded in `docs/DECISIONS.md`.

**Baseline.** The original brief is `Meridian Take Home Feedback Revised PRD.docx` at the repository
root, preserved byte-for-byte and never edited. It is traceability material, not a specification:
several of its statements were not implementable against the schema it also specified, and each such
conflict is resolved below.

---

## 1. Product contract

Deliver the whole whiteboard-to-agent lifecycle for Inbound Import Receiving, and nothing wider. The
board is an authoring surface that stores a simple process description; that description compiles
into an immutable JSON specification; Temporal runs ordinary generated TypeScript against it.

Board metadata lives apart from independently editable node and edge rows, so editing one card never
rewrites a hundred-node graph. Immutable snapshots are taken only at review and freeze boundaries.
Generated code and eval fixtures live in Git. Supabase stores lineage, bounded execution summaries,
per-instance step attempts, append-only events, and reserved external actions.

## 2. The four primitives

Exactly four, unchanged from the baseline. There is no fifth card type and no sub-type that behaves
like one.

| Primitive   | Combines                          | Card data                                                                                                                             |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Input**   | Event + Information               | `title`, `inputKind=event\|document\|data`, `sourceSystem`, `required`, `fields[]`, `correlationKeys[]`                               |
| **Action**  | Task + System + Human Handoff     | `title`, `actor=agent\|human\|system`, `operation`, `instructions`, `system`, `inputs[]`, `outputs[]`                                 |
| **Rule**    | Decision + Wait + retry/exception | `title`, `ruleKind=decision\|wait\|retry\|exception`, `condition`, `branches[]`, `timeoutMinutes?`, `maxAttempts?`, `fallbackNodeId?` |
| **Outcome** | The meaningful result             | `title`, `resultKind=ready\|needs_information\|manual_review\|rejected\|completed`, `terminal`, `requiredAction?`                     |

Connections live in `whiteboard_edges`, never inside the board row. Cycles are allowed; a Rule card
explains why a branch, wait, retry, or exception path exists.

## 3. The transactional write path

The canvas is reconstructed from `whiteboards` + `whiteboard_nodes` + `whiteboard_edges`. The client
keeps a local graph and sends a delta with the expected `revision_no`.

1. Browser roles may `SELECT` authorized rows in those three tables and may **not** `INSERT`,
   `UPDATE`, or `DELETE` any of them. The privileges are revoked and no write policy exists, so a
   browser cannot write `revision_no`, `viewport_json`, `last_reviewed_revision_no`, `status`,
   `title`, or the timestamps under any circumstances.
2. Creation goes through `create_whiteboard`, title through `rename_whiteboard`, status through
   `set_whiteboard_status`, graph and viewport through `save_whiteboard_delta`.
   `last_reviewed_revision_no` moves only inside `finalize_review_session`; freeze sets status only
   inside `freeze_whiteboard_spec`.
3. `save_whiteboard_delta` verifies ownership, locks the board `FOR UPDATE`, and aborts on a
   mismatched `expected_revision_no` with `STALE_BOARD_REVISION`.
4. Every update supplies the exact current `row_version`; a mismatch aborts the **whole** delta with
   `STALE_NODE_ROW_VERSION` or `STALE_EDGE_ROW_VERSION`. No partial mutation is ever committed.
5. Mutation order inside the single transaction is fixed: validate → node upserts → edge upserts →
   edge deletes → node deletes → viewport → revision increment.
6. Changed row versions increment exactly once each; the board revision increments at most once.

Renaming is the same contract: `rename_whiteboard` takes an expected revision, increments once,
returns the board to `draft`, and leaves `last_reviewed_revision_no` alone. Renaming to the identical
text is a no-op that does not increment.

## 4. Canonicalization and hashing

One implementation, `packages/core/src/hashing.ts`, exporting `canonicalJson`, `canonicalBytes`, and
`sha256Hex`. Every app, service, script, skill, and test imports it. No other module may reimplement
either operation.

1. Nodes sorted by `nodeId`, edges by `edgeId`, before snapshot assembly.
2. Object keys sorted recursively by UTF-16 code unit — RFC 8785 ordering.
3. Semantically meaningful arrays keep their order: `branches[]`, `fields[]`, `inputs[]`,
   `outputs[]`, `correlationKeys[]`, `acceptanceCriteria[]`, `assumptions[]`, `knownGaps[]`.
4. Set-like collections (`capabilities`, `unresolvedCommentIds`, `reviewSessionIds`) are sorted and
   de-duplicated _before_ reaching the canonicalizer.
5. `NaN` and `±Infinity` are rejected. `-0` canonicalizes to `0`, matching ECMAScript
   `Number::toString` and therefore RFC 8785. One shared `serializeNumber()` serves the canonicalizer
   and its tests.
6. `undefined` in an array, functions, symbols, `BigInt`, `Date`, `Map`, and `Set` are rejected.
7. UTF-8 encode, SHA-256, 64 lowercase hex characters.

**PostgreSQL `jsonb` does not preserve formatting, key order, or duplicate keys**, and normalizes
numeric literals through `numeric`. No stored `jsonb` value is ever described as byte-preserving, and
every hash comparison re-canonicalizes the value read back from the database.

Hashes identify content and let the system verify equality. They are not authentication and prove
nothing about who created or approved anything.

## 5. Review, comments, and issue identity

**Review and freeze are separate actions.** The model never comments while the board is being drawn;
the user clicks **Review Process**.

The review request is **one synchronous, fully awaited HTTP request**. No detached promise, no
`void`-ed call, no `setTimeout`, no `after()`. A route handler that returns before its work finishes
has no guarantee the rest runs, and a review that dies silently would wedge a `running` session
behind the active-session unique index forever. Ordering:

1. Authenticate and load the board; a non-owner gets 404.
2. Assemble the canonical snapshot **on the server** and compute `source_canvas_hash`. No request
   schema in the system has a `sourceCanvasJson` or `sourceCanvasHash` field, so there is nothing to
   forge.
3. Run the 15 deterministic checks against that snapshot, before any network call, so a model outage
   still produces deterministic findings.
4. Resolve the actual model **before the session row exists** — `model_name` and `reasoning_effort`
   are immutable once a session leaves `queued`, so the session cannot be created before the model is
   known. On `model_not_found`, adopt the configured fallback if one is allowed, else return 503 with
   no session created.
5. `create_review_session`: lock, reject archived, reject a stale revision, reject a concurrent
   active session, allocate `round_no`, insert directly as `running`.
6. Await the model with **no lock held**, under `AI_REVIEW_TIMEOUT_MS`, retrying at most twice on
   429/5xx/network.
7. `finalize_review_session`: insert all findings, write the summary, complete the session, and set
   `last_reviewed_revision_no`. Idempotent, keyed on `(review_session_id, issue_key)`.
8. Any failure after session creation calls `fail_review_session` in a `finally`, so a session is
   never left `running`.

**The 15 deterministic checks.** Disconnected nodes; unreachable outcomes; missing initial path;
missing terminal path; unlabeled Rule branches; missing required primitive fields; invalid edge
references; orphaned exception paths; Actions without an actor; agent/system Actions without required
system information; Rules with invalid branch configuration; retry Rules without `maxAttempts`; wait
Rules without `timeoutMinutes`; unknown capabilities; decision Rules whose branch labels and outgoing
arrow labels describe different ways forward.

The last of those was not in the original fourteen. It was added once the authoring UI showed both
halves of a decision at the same time, which made it visible that a board records the ways out of a
Rule twice — as branch labels and as edge labels — with nothing in the schema keeping them equal.
It is non-blocking: a board can be mid-edit and still compile. See DECISIONS.md.

**Issue identity.** `issue_key` is stored, never recomputed at read time:
`det:<checkCode>:<anchorType>:<anchorId ?? 'canvas'>:<fieldPath ?? '-'>` for deterministic findings,
`mod:<normalizedIssueCode>:…` for model findings, where the code comes from a closed enum the
structured-output schema enforces. Findings collapse by `issue_key` within a round; a recurrence
across rounds appends a system reply rather than creating a second root.

**Comment meaning comes from `metadata_json`, never from body text.** The metadata is a discriminated
union over `review_issue`, `reply`, `rejection`, `graph_patch`, `assumption`, and `policy_gap`. No
component anywhere parses a comment body prefix.

**One definition of unresolved**, in SQL and TypeScript both:

```
unresolved  ==  parent_comment_id IS NULL AND status IN ('open', 'answered')
```

A **rejected root is not unresolved**. It was dismissed deliberately with a recorded rationale, it
stays visible in history, it is never auto-reopened, and it never enters `unresolved_comment_ids`,
never warns at freeze, and never counts. Freeze warnings are narrower still: only unresolved roots
with `severity = 'blocking'`.

## 6. The frozen specification

```ts
spec_json = {
  schemaVersion: '1.1',
  identity: { specId, whiteboardId, specVersion, name },
  source: { revisionNo, canvasHash, reviewSessionIds, frozenAt },
  process: { nodes, transitions, initialNodeIds, terminalNodeIds },
  data: { documentTypes, fieldSchemas, correlationKeys },
  policies: { validationRules, waits, retries, exceptions, humanHandoffs },
  capabilities: ['mail.read', 'mail.send', 'browser.read', 'document.extract'],
  outputs: { decisionSchema, emailResponseSchema, shipmentSummarySchema },
  assumptions: [{ text, sourceCommentId }],
  knownGaps: [{ text, severity, sourceCommentId }],
  acceptanceCriteria: [...]
}
```

The compiler rejects missing references, impossible start or terminal paths, duplicate IDs, invalid
card data, and unknown capabilities.

**Freeze holds no lock across compilation.** Compile revision `R` outside any lock, then lock, then
re-check that `revision_no` is still `R` — aborting with `BOARD_CHANGED_DURING_FREEZE` if not, which
the service retries up to three times — then allocate `spec_version` and insert.

**Warnings, not silent blocks.** Unresolved blocking comments warn and are recorded; the user may
continue after acknowledging. A stale review warns separately and also requires acknowledgement, but
does not force a new review. Both acknowledgements are recorded in `spec_json.source`.

## 7. Lifecycle machines

Each is enforced by a `BEFORE UPDATE` trigger that rejects any transition outside its set.

- **Whiteboards** — `draft → review_ready → submitted`, with any successful delta returning to
  `draft` from either later state. Submitted boards stay editable; editing does not touch the frozen
  spec. Anything may be archived.
- **Agent versions** — `reserved → generated → evaluating → approved`, plus `→ superseded`.
  Approval does **not** activate.
- **Executions** — `queued → running → passed|failed|error`. The one exception is
  `create_manual_review_intake_execution`, which inserts an already-terminal row rather than
  transitioning one.
- **Actions** — `reserved → dispatched → succeeded|failed`, with `dispatched → needs_reconciliation`
  and `needs_reconciliation → succeeded|reserved|abandoned`. **`dispatched → reserved` does not
  exist.** The only route back to `reserved` requires positive proof of non-delivery in
  `reconciliation_json`.

## 8. Agents, versions, activation

`agents` is the logical agent. `agent_versions` are its immutable versions. Activation is an explicit
operator action that sets the release pointer; **approval never activates**. Rollback is activation
of an earlier approved version, and it does not rewrite the version rows of executions that already
ran.

Two logical agents may share one whiteboard, and their version numbering is independent.

## 9. Executions, steps, events, actions

- `step_instance_key` is logical step identity. `(execution_id, step_instance_key, attempt_no)` is
  unique. Retries share the instance key and differ by attempt.
- `sequence_no` is **display ordering only**. It is not unique and carries no identity.
- `execution_events` is append-only, enforced by trigger.
- Every external effect is **reserved → dispatched → completed**, with the provider call strictly
  between dispatch and completion. The idempotency key is derived from
  `(executionId, stepInstanceKey, actionType, payload)`.
- Gmail accepts no client-supplied idempotency token, so the delivery claim is honest: **replay
  deduplication is exact; external delivery is best-effort**. The adapter appends a
  `[meridian-ref: <token>]` footer, and reconciliation searches for that token. When reconciliation
  cannot conclude safely, the action ends `needs_reconciliation` or `abandoned`, the workflow
  produces an escalating outcome, and the UI surfaces the pending action. **Nothing is ever resent
  blindly.**

## 10. The runtime boundary

Generated agents import `@meridian/agent-kit/contracts` and `zod` and nothing else — no provider SDK,
no Supabase client, no `node:*`, no wall clock, no randomness. The restriction is an ESLint rule, so
a violation fails `pnpm lint`.

The registry is **static**: a generated `generated-agents/index.ts` with top-level imports, compiled
into the workflow bundle. There is no dynamic `import()` and no filesystem globbing, because neither
exists inside the workflow sandbox. Adding a version requires regenerating the registry and
restarting the worker, and `pnpm health` reports any version that is active in the database but not
bundled in the worker.

Every execution pins `agent_version_id`, `spec_hash`, and `git_commit_sha`. A running workflow never
upgrades itself.

## 11. Correlation intake

The business key is extracted **before** any workflow starts, outside the workflow.

1. Fetch and normalize the message outside any workflow.
2. Extract and normalize the container number (ISO 6346 check digit) or MAWB (IATA check digit).
3. **No reliable key, or conflicting keys** ⇒ `create_manual_review_intake_execution`, which writes
   one already-terminal row with `temporal_workflow_id = NULL`, `business_key = NULL`, a structured
   reason, an evidence event, and `completed_at`, in one transaction — **and starts no workflow**.
4. Derive the deterministic workflow ID `receiving:<BUSINESSKEY>`.
5. `create_execution`, idempotent on `idempotency_key`.
6. **`client.workflow.signalWithStart`** — one call that starts or signals, atomically, on the
   Temporal server. There is no start attempt to lose a race, and no `AlreadyStarted` error on the
   happy path.
7. Persist the returned run ID through `start_execution`.
8. If step 7 fails the workflow is already durable, so the row stays `queued` and
   `reconcile-queued-executions` reattaches it. It never starts a second workflow, and
   `uq_executions_active_workflow` makes two active executions for one workflow ID impossible anyway.

## 12. Operator-invoked generation

Generation is invoked by an operator running a Codex skill. **No HTTP route invokes Cursor or Codex**,
and no route shells out. The UI prints the exact `/goal` command; the operator runs it.

`spec-to-agent` writes exactly five files inside the reserved `code_path` — `agent.ts`, `rules.ts`,
`prompts.ts`, `manifest.json`, `spec.snapshot.json` — and never edits the frozen spec or the shared
runtime. `agent:finalize` commits only allow-listed paths and then re-reads the commit **out of the
Git object database** with `ls-tree` and `show`, because a worktree can be edited a second after the
commit and a verification that trusts it would bless the edit.

`eval-repair` classifies each failure as `extraction`, `implementation`, `tool_infrastructure`, or
`policy_gap`. It may repair the first two, in a **new** version reserved with
`parent_agent_version_id` set — never by mutating an evaluated folder. A `policy_gap` records a
blocking board comment and **stops**, because the alternative is inventing business policy nobody
reviewed. The loop is bounded at three iterations.

## 13. RLS, privileges, immutability

Row-level security is on for every table. Ownership derives from `whiteboards.owner_id` and is
re-derived server-side on every request; a client-supplied owner is never trusted.

Six trusted-artifact RPCs are `service_role`-only — `create_review_session`,
`finalize_review_session`, `fail_review_session`, `freeze_whiteboard_spec`, `record_policy_gap`,
`record_agent_commit` — along with every execution and action RPC. They are called by the server, the
worker, and the operator CLI, never by a browser.

`frozen_specs` and `execution_events` are immutable: update and delete are rejected by trigger for
every role including `service_role`.

## 14. Lineage

```
Whiteboard → Review Session → Frozen Spec → Agent → Agent Version → Git Commit
                                                          ↓
                                    Execution → Steps → Events → Actions
```

Every link is a foreign key or a verified hash, not a convention. Given any execution you can reach
the exact drawing it came from, the exact review that shaped it, the exact specification it was
compiled from, and the exact commit that ran.
