# Demo walkthrough

The full lifecycle, from an empty board to a rolled-back agent version. Every step runs against
deterministic mocks; no paid API key is needed.

Two terminals. Terminal A runs `pnpm dev` and blocks. Everything else runs in terminal B.

**Recording the assignment demo instead?** Go to [Recording the demo](#recording-the-demo) at the end.
That walkthrough runs against the deployed app rather than a local stack, and is ordered as a script
to narrate rather than a checklist to verify.

---

## Setup

1. `pnpm preflight` — every check passes, and the last line names the **resolved** Composio Gmail
   toolkit version, not `latest`.
2. `pnpm install --frozen-lockfile`.
3. `pnpm build` — `build:ts` compiles every project including `packages/ops`, then `build:web` runs
   `next build` to completion.
4. `pnpm dev:infra` — returns immediately; Supabase and Temporal are ready.
5. `pnpm db:reset && pnpm db:types && pnpm seed`.
6. Terminal A: `pnpm dev`. Terminal B: `pnpm health` — all four green.

## Authoring

7. Open `http://localhost:3000` and sign in as `DEMO_USER_EMAIL`.
8. The board list shows the seeded **Inbound Import Receiving** board with the badge
   _Never reviewed_.
9. Open it. The canvas renders Input, Action, Rule, and Outcome cards.
10. Drag one Action card. Exactly one node row updates and `revisionNo` increments once — not once
    per animation frame.
11. Edit that card's `instructions` in the Inspector and save. Its `rowVersion` increments once.
12. Add a Rule card with `ruleKind='decision'` and two branches, and connect it with two labelled
    edges.
13. Leave one branch **unlabelled**, deliberately. It is about to be found.
14. Rename the board from the header. `revisionNo` increments once, the status returns to `draft`,
    and `lastReviewedRevisionNo` does not move — a rename is the same optimistic-concurrency contract
    as a graph edit. Rename it back to the identical text: nothing increments, because a no-op is a
    no-op.

## Review

15. Click **Review Process**. The button enters a loading state and **stays** there. This request is
    synchronous and fully awaited; there is no polling and no background task.
16. The request resolves with the terminal result. Threads appear anchored to specific nodes and
    edges.
17. One thread is the deterministic `UNLABELED_RULE_BRANCH` finding, with its `issue_key` visible.
18. Reply to a model finding. The root badge becomes **answered** — not resolved. Answering a
    question is not the same as fixing the thing.
19. Reject a different finding with a reason. The rationale is visible in the thread and stays there.
20. Convert one answer into an explicit assumption. It appears in the assumptions list.
21. Apply a suggested patch on a third finding. The board revision increments and a system reply
    records the patch.
22. Fix the unlabelled branch by adding a label.
23. The badge now reads _Board changed since review_.
24. Click **Review Process** again — round 2.
25. The unlabelled-branch issue becomes **resolved**. The answered-only issue stays **answered**. The
    rejected issue stays **rejected** and is not reopened.
26. Check the unresolved counter: it counts only `open` and `answered` roots. The rejected finding is
    still visible under _Dismissed_, is not counted, and produces no blocker warning.

## Freeze

27. Click **Freeze Spec**. Warnings appear for genuinely unresolved **blocking** roots only — the
    rejected one is absent — plus the stale-review warning if the board moved since round 2.
28. Tick both acknowledgements and freeze. The warnings do not block; they require an explicit
    acknowledgement, and both are recorded in `spec_json.source`.
29. The spec page shows `specVersion = 1`, both hashes, `unresolvedCommentIds`, the assumption, and
    the known gaps.
30. Download the spec. Re-deriving `spec_hash` from the downloaded document reproduces the displayed
    value. Note that `shasum -a 256` of the file does **not**, and is not meant to: the hash is taken
    over the semantic view — the contract without `specId`, `specVersion`, `frozenAt`, the review
    session ids or the acknowledgement flags — so that re-freezing an unchanged board is recognisably
    the same spec. `freeze-spec.spec.ts` asserts it the correct way, with `deriveSpecHash`.

## Generation

31. On the Agents page, create the logical agent `inbound-import-receiving`.
32. Reserve version 1. The UI prints the exact `/goal` command and
    `codePath = generated-agents/inbound-import-receiving/v001`.
33. Run the `spec-to-agent` skill in Cursor or Codex. It writes exactly five files:
    `agent.ts`, `rules.ts`, `prompts.ts`, `manifest.json`, `spec.snapshot.json`.
34. `bash .codex/skills/spec-to-agent/scripts/verify.sh` — lint, typecheck, unit tests, and one
    smoke eval, all passing.
35. `pnpm agent:finalize --agent-version <id>` — commits the allow-listed paths, then re-reads the
    commit **out of the Git object database** to confirm it contains what it claims. The version now
    shows a 40-hex SHA.
36. `pnpm agent:verify-manifest --agent-version <id>` — re-verifies the same claim later, reading
    only the object database, with no dependence on the current working tree.
37. Restart the worker in terminal A so the regenerated registry is bundled. `/healthz` now lists
    `inbound-import-receiving@1`. (`pnpm health` flags this gap if you forget.)
38. Transition the version to `evaluating`. The gate passes because the SHA and manifest are valid.

## Evals and repair

39. `pnpm evals --agent-version <id>` — the API returned 202 immediately; the CLI runs 15 cases.
40. A case fails. Open the execution and read the failing step with its `step_instance_key` and the
    evidence events around it.
41. Run `eval-repair`. It classifies the failure, reserves v002 with
    `parent_agent_version_id = v001`, copies the five files, patches, and re-runs the **whole** suite.
42. All 15 cases pass on v002. v001's folder is byte-for-byte unchanged — a repair never mutates an
    evaluated version.
43. If a case had instead traced to a **policy gap**, the run would have recorded a blocking comment
    on the board and exited 5 without patching anything. That is a successful outcome: the
    specification does not decide the case, and inventing the answer in generated code is the one
    thing the loop must never do.

## Activation and live-style run

44. Approve v002. The agent is **still not live** — the release pointer is unset. Approval and
    activation are different decisions.
45. Activate v002. The agent status becomes `active` and the pointer is set.
46. `pnpm demo` — a live-style run over the mock mailbox. Intake extracts the container number
    **before** the workflow starts, then makes one `signalWithStart` call.
47. A second message for the same container reaches the existing workflow through the **same**
    `signalWithStart` call — the Temporal server routes it as a signal because the workflow ID exists,
    so there is no start attempt to fail and no race window. The execution list still shows one row.
48. The `no-business-key.eml` fixture produces a terminal `manual_review` row with a null business
    key, no workflow ID, a completion timestamp, and one evidence event explaining why. **No workflow
    was started.**
49. The execution detail shows the agent, version, spec hash, Git SHA, resolved toolkit version, and
    business key; steps grouped by `step_instance_key` with their retries; a paged event feed; and
    exactly one `mail.send` action that moved `reserved → dispatched → succeeded` with `attempt_count`
    at 1 and `completed_at` set only at the terminal step.
50. Roll back to v001 via **Activate**. A new run resolves to v001, while the earlier execution rows
    still reference v002 and still report the spec hash and commit they actually ran under.

## The rest of the assignment

```bash
pnpm test:scale         # a 101-node board saved, reviewed, and frozen
pnpm test:multi-agent   # two logical agents on one board, independent versions and pointers
pnpm verify             # every static gate, next build included
pnpm verify:e2e         # everything that needs a live stack
pnpm stop               # leaves a foreign Supabase stack running
```

---

# Recording the demo

The lifecycle again, but against <https://meridian-web-dibyadeep-sahas-projects.vercel.app> and
ordered for a camera. The walkthrough above is a verification checklist; this is a script.

## What happens where, and why

Most of it is the browser. Two steps are not, and the reason is worth saying out loud while
recording, because it is a design position rather than an omission.

| Lifecycle step               | Where             | Why there                                                                                                    |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Whiteboard, review, freeze   | Deployed app      | Authoring and review are the product                                                                         |
| Reserve a version            | Deployed app      | The version row is reserved before any code exists, so generation has something to fill                      |
| Generate the agent           | Cursor + terminal | Generation writes files into the repository and commits them; a web request cannot                           |
| Evals                        | Terminal          | An eighteen-case suite cannot be held open inside an HTTP request, so the route enqueues and the CLI runs it |
| Trigger a run, read evidence | Deployed app      | This is what an operator does daily                                                                          |

The terminal steps talk to the **deployed** database, not a local one, so everything you do in a
terminal shows up in the browser a moment later. Point them there by prefixing the command with the
two values from `.env.vercel` (git-ignored; do not read it aloud on camera):

```bash
NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<sb_secret_…>' \
pnpm evals --agent-version <id>
```

The eval harness runs the generated agent in-process and writes execution rows straight to Supabase.
It does not go through Temporal, so it needs no worker and works the same whichever database it is
pointed at.

### What someone with only the link can do

Everything the running system does. No clone, no install, no keys:

sign in; create and edit boards; run AI review rounds; reply, reject, record assumptions and apply
patches; freeze a specification and download it; create an agent and reserve a version; approve a
version and activate or roll back the release; trigger live runs against the deployed worker; answer
a human handoff; and read every execution's steps, events, external actions and — for eval runs —
the expected-against-actual diff.

Two things need the repository, and both for the same reason: they produce or check **committed
code**, which no web request can do.

- **Generating a version's code.** The deliverable of generation is five source files in a Git
  commit, whose SHA the version row records and `agent:verify-manifest` later re-reads out of the
  object database. A hosted button could only fake that — by writing agent behaviour into database
  rows and interpreting it at run time, which would abandon the immutability and lineage the rest of
  the design rests on. The reserve panel says so rather than spinning: _"Run this in Cursor or Codex.
  Meridian will not generate the code for you."_
- **Running the eval suite.** Eighteen cases take longer than an HTTP request may live, so the route
  enqueues and the CLI executes. There is deliberately no button, because a button that queued work
  nothing would pick up is worse than no button.

A visitor is not blocked by either. Both agents are already generated, and both suites have already
run against the deployed database, so the artifacts of those two steps — the code paths, the commit
SHAs, `case-18` failing on v001 and passing on v002 — are all readable in the browser. What a
visitor cannot do is mint a _new_ generated version, which is an operator action by design.

## What is in the deployed environment

Recorded here because "start from the seeded state" is only useful if the seeded state is written
down somewhere.

| Thing                                 | State                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound Import Receiving              | Frozen, agent active at v001, never reviewed in the UI                                                                                                                 |
| Vendor Insurance Certificate Renewal  | Frozen, agent active at v001, never reviewed in the UI                                                                                                                 |
| Inbound Import Receiving (first pass) | Draft, never reviewed — the board Act 1 opens                                                                                                                          |
| Executions                            | Ten live runs from `pnpm demo`: four `ready`, one `needs_information`, four `manual_review`, plus two messages that reached a terminal row without starting a workflow |
| Eval runs                             | v001 at 17/18 (fails `case-18`) and v002 at 18/18                                                                                                                      |
| `inbound-import-receiving` v002       | `evaluating`, finalized with a commit SHA — approve and activate it on camera                                                                                          |

## Before you press record

1. `curl -s https://meridian-web-dibyadeep-sahas-projects.vercel.app/api/health` — four `true`s. If
   `worker` is false, Render has spun the container down; open its URL once and wait a minute.
2. Reset the demo data, so the board list is the two seeded boards and nothing else (see
   [Resetting the demo data](#resetting-the-demo-data)).
3. Sign in as `demo@meridian.local` in a clean browser profile. A profile with your Vercel session in
   it can redirect through SSO on camera.
4. Know the waits, and decide now where to cut: **a review takes 50–90 seconds**, a live run about a
   minute, freezing is instant.
5. Do not start `pnpm dev` for the local stack during the recording. It is safe now — local uses the
   `meridian-receiving-local` task queue — but a second web app on `localhost:3000` reading a
   different database is an easy thing to film by accident.

## Act 1 — Whiteboard the process badly, on purpose

> Task 3 §1. The point of this act is that the first version is _wrong_, and that being wrong is
> visible rather than embarrassing.

Open **Inbound Import Receiving (first pass)**. It is seeded as a draft, has never been reviewed,
and is the process as it comes out of one conversation with the receiving team: an email arrives,
someone reads the attachments, someone decides whether it all looks right. Eight cards.

Name what is deliberately absent, because the reviewer is about to find every bit of it: no list of
which documents are required, no check that the invoice and the certificate agree, no correlation
key, no failure path on extraction, one branch out of the decision with no label, and a _Certificate
of analysis_ card nobody connected to anything.

To build it live instead: **Create** on `/boards` (the button stays disabled until the title box has
something in it), add cards from the palette — **Something arrives** (Input), **Do some work**
(Action), **Decide or wait** (Rule), **Reach a result** (Outcome) — and connect them by dragging
from a card's right-hand handle onto the next card's left-hand handle. Those four primitives are the
entire vocabulary: everything a customer says has to land in one of them, which is what makes a
board compilable at all. The toolbar reads `Saved · revision N` after each edit, because every
change is one optimistic-concurrency write rather than an autosave of the whole board.

## Act 2 — First AI review

> Task 3 §2, round one.

1. Click **Review Process**. It stays busy for 50–90 seconds and does not poll: the request is
   awaited end to end, so when it returns, the round is genuinely finished.
2. Findings arrive as threads in the right-hand panel and as pins on the canvas beside the card each
   one is about. Two kinds are mixed together deliberately: deterministic structural checks (the
   unlabelled branch will be one) and model findings about the business logic.
3. Now play the business user, using a different control for each kind of answer, because they mean
   different things:
   - **Reply** to a finding you want to answer in prose. The thread becomes `answered`, not
     `resolved` — answering a question is not the same as fixing the thing.
   - **Record assumption** where the business genuinely has no rule yet. Assumptions are the only
     evidence that closes a model finding, they are published into the frozen spec, and the next
     round is told about them so it stops asking a question you have answered.
   - **Reject** one finding with a reason. It moves to _Dismissed_, stops counting toward the
     unresolved total, and is never reopened by a later round.
   - **Apply suggested patch** where the reviewer offered one; the board revision increments and a
     system reply records what it changed.
4. Then actually fix two things on the board: label the unlabelled branch, and add the missing
   required-document fields to the Input card.
5. The header badge changes to _Board changed since review_.

## Act 3 — Second AI review

> Task 3 §2, round two. This is the act that shows the loop is a loop.

6. Click **Review Process** again.
7. Read the reconciliation out loud, because it is the whole argument:
   - the unlabelled-branch finding is now **resolved** — and nobody clicked "resolve", there is no
     such control; it closed because you fixed the board and the check stopped firing;
   - the one you recorded an assumption on is **resolved** too, on different evidence: a model
     finding needs a human decision on the thread, not merely a model that went quiet;
   - the finding you only answered in prose is still **answered**, because a reply changes neither
     the board nor the spec;
   - the rejected one is still dismissed, uncounted, and not resurrected.
8. The unresolved counter counts `open` and `answered` roots only.

## Act 4 — Freeze the specification

> Task 3 §3.

9. Click **Submit Process**. The dialog previews what is still unresolved.
10. Tick each acknowledgement. Freezing **warns rather than blocks**: the tool cannot know whether a
    finding matters, but it can refuse to let the acknowledgement be implicit, so the confirm button
    stays disabled until every warning shown is ticked.
11. Freeze. The spec page shows `specVersion`, the spec hash, the canvas hash, the unresolved comment
    ids, your assumptions, and the known gaps — the acknowledgements are recorded _in the document_,
    not just in a log.
12. Download it. The spec is immutable from here; the agent is generated from this artifact and not
    from the board, which is why the board can keep moving afterwards.

## Act 5 — Generate the agent

> Task 3 §4.

13. On **Agents**, create a logical agent for the board and give it a deployment key.
14. **Reserve a version**. Nothing is generated yet: the row exists, the code path is allocated, and
    the page prints the exact command to run and the `codePath` it must write to.
15. Paste that command into Cursor. The `spec-to-agent` skill reads the frozen spec and writes
    exactly five files — `agent.ts`, `rules.ts`, `prompts.ts`, `manifest.json`, `spec.snapshot.json`.
16. `bash .codex/skills/spec-to-agent/scripts/verify.sh` — lint, typecheck, unit tests, one smoke
    eval.
17. `pnpm agent:finalize --agent-version <id>` (with the cloud prefix above). It commits the
    allow-listed paths, then re-reads the commit **out of the Git object database** to confirm it
    contains what it claims. The version now carries a 40-hex SHA that can be checked later without
    trusting the working tree.

If you intend to trigger a **live** run of a newly generated version, push first and let Render
rebuild: the worker bundles the agent registry at build time, so a version that exists only in the
database is not yet runnable by the deployed worker. Evals do not care — they run in-process.

## Act 6 — Evals, and the loop that refuses

> Task 3 §5.

18. `pnpm evals --agent-version <id>` (cloud prefix). Cases run concurrently against the fixture
    mailbox; the summary prints per-case pass or fail.
19. Open a case in **Executions**. An eval row shows expected against actual, with the diff.
20. On a failure, run the `eval-repair` skill. Say what it does and, more importantly, what it
    refuses: three of the four failure classes are repairable, and the fourth — a **policy gap** — is
    not. There the suite records a blocking comment back on the board and exits 5 without patching
    anything, because the specification does not decide that case and inventing the answer in
    generated code is the one move that would make the suite green and meaningless.
21. A repair never edits an evaluated version. `pnpm agent:reserve-repair --parent <id>` allocates the
    next version with its lineage set and copies the five files; the patch lands there, and the
    **whole** suite is re-run, not just the case that failed.

### The repair this repository actually ran

`case-18` is the case worth narrating, because it is a defect the corpus found rather than one
planted for the camera.

The SOP names four identifiers a good must carry, and v001 encoded exactly those four. Two other
statements in the same specification also bear on a line: the commercial invoice input marks
`batchNumber` **required**, and the certificate rule reads "every batch named on an invoice must be
covered by exactly one certificate of analysis". A line naming no batch does not satisfy that rule
trivially — it is a line the rule cannot be evaluated for at all. v001 read the four-identifier
sentence and stopped there, so a good with no batch raised no missing-field failure, and because the
certificate matcher only iterates batches that exist, it was invisible to that check too. The
shipment received.

That is an `implementation` failure, not a policy gap: the specification decides the case, and the
code disagreed with it. So the loop is allowed to repair it, and did — v002 adds `batchNumber` to
the blocking list, and the whole suite passes 18/18. v001's folder is byte-for-byte unchanged and
still fails `case-18`, which is the point of versioning it rather than editing it.

| Version | Suite | `case-18`                                            |
| ------- | ----- | ---------------------------------------------------- |
| v001    | 17/18 | Fails: received a shipment with no batch on the line |
| v002    | 18/18 | Passes: asks the forwarder for the Batch Number      |

## Act 7 — Run it, and read the evidence

22. On **Executions**, use **Send a pre-alert email** to hand a fixture message to intake. The
    business key is extracted _before_ the workflow starts, then one `signalWithStart` call either
    starts the workflow or delivers to the running one — so a second message for the same container
    joins the existing execution rather than racing it.
23. Open the execution: the agent, version, spec hash, Git commit and resolved toolkit version it ran
    under; steps grouped by `step_instance_key` with their retries; a paged event feed; and each
    external action moving `reserved → dispatched → succeeded` with its attempt count.
24. If the run reached `needs_information`, open the operator inbox: the email the agent composed is
    actually there, sent through Composio, carrying the `[meridian-ref: …]` footer that the external
    action recorded. Worth showing, because it is the only claim in the viewer a reader can check
    from outside the system — the deployment reads fixture mail so runs stay reproducible, but it
    sends for real. The reply arrives as its own message rather than on the thread, since the thread
    it answers exists only in `examples/`.
25. On **Agents**, **Approve** v002 and then **Activate** it. Two buttons because they are two
    decisions: approval says the version is fit to run, activation says it is what runs now. A
    version can sit approved indefinitely and nothing changes for a single shipment.

    Check `<worker url>/healthz` lists `inbound-import-receiving` at version 2 before activating.
    The worker bundles the registry at build time, so activating a version it was not built with
    points live runs at code that host cannot load.

26. Close on lineage: roll back to v001 from the same panel and note that the old execution
    rows still report the spec hash and commit _they_ ran under. Rolling back changes what runs next,
    never what a past run claims about itself.

## Resetting the demo data

Deleting a board does not cascade into its agents or frozen specs — those references are deliberately
not `on delete cascade`, so a board cannot be quietly deleted out from under an agent that was
generated from it. Reset in dependency order, then re-seed:

````bash
# Executions and their children, then versions, agents, specs, boards.
psql "$SUPABASE_DB_URL" -c "
  delete from public.executions;
  delete from public.agent_versions;
  delete from public.agents;
  delete from public.frozen_specs;
  delete from public.whiteboards;"

Then seed all three boards. The first two are seeded finished; the third is the draft Act 1 opens,
and `--draft` is what stops the seed freezing a specification nobody has reviewed:

```bash
# With NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and
# SUPABASE_DB_URL exported for the hosted project:
pnpm seed
pnpm seed --board examples/vendor-coi-renewal/board.seed.json
pnpm seed --board examples/inbound-import-receiving/board.first-pass.seed.json --draft
````

The seed refuses to run with a dirty working tree, because it records the current commit SHA on the
agent versions it releases and a SHA that does not describe the code is worse than no SHA.

To restore the executions and eval runs the table above describes, run `pnpm demo` against the
deployed queue and the eval suite against each version:

```bash
TEMPORAL_TASK_QUEUE=meridian-receiving pnpm demo   # ten live runs on the deployed worker
pnpm evals --agent-version <v001 id>               # 17/18, case-18 fails
pnpm evals --agent-version <v002 id>               # 18/18
```

`pnpm seed` is idempotent, which also means it will not repair a board you have edited — it skips
what already exists. Deleting first is what makes it a reset rather than a no-op.

## If something goes wrong on camera

| Symptom                                   | What it is                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_MODEL_CALL_FAILED`                | The model call passed its abort budget. Click review again; the session is already marked failed, so nothing is stuck |
| Review button busy for over three minutes | The request budget is 300s. Reload; a completed round is already persisted                                            |
| `STALE_BOARD_REVISION`                    | The board moved between opening the dialog and confirming. Reload and redo the action                                 |
| Health shows `worker: false`              | Render spun the free container down. Open the worker URL once, wait a minute                                          |
| An eval case fails that passed before     | Check which database the terminal is pointed at before assuming a code defect                                         |
