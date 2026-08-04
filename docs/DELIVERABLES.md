# Deliverables

Where each thing the assignment asks for lives, and how to see it working. Anything not yet done is
said so plainly rather than left for the reader to discover.

Read `README.md` first for the cold start, `docs/DEMO.md` for the guided walkthrough,
`docs/ARCHITECTURE.md` for how the pieces fit, and `docs/DECISIONS.md` for the choices that are not
obvious from the code.

---

## Task 1 — Whiteboard mode

### a) The canvas

Four primitives, each explainable to a non-engineer in one sentence:

| Primitive   | One sentence                                                     |
| ----------- | ---------------------------------------------------------------- |
| **Input**   | Something the process receives — an email, a document, an event. |
| **Action**  | Something someone or something does, by hand or by system.       |
| **Rule**    | A question the process asks, and where each answer leads.        |
| **Outcome** | A state a run can finish in.                                     |

Four and not more. Branches, waits, retries, exceptions, and human handoffs are all _kinds of Rule_
rather than primitives of their own, because a process owner who can answer "what question is being
asked here?" can place every one of them, and a fifth card would have needed a paragraph to explain.
The tradeoff and the cards that were considered and rejected are recorded in `docs/DECISIONS.md`.

- Canvas: `apps/web/src/app/boards/[whiteboardId]` and `apps/web/src/features/whiteboard`
- Primitive schemas: `packages/core/src/schemas/primitives.ts`
- Human-readable labels shown in the UI: `packages/core/src/vocabulary.ts`
- See it: `pnpm dev`, then open the seeded **Inbound Import Receiving** board.

### b) AI review

An agent reads the canonical graph and leaves structured comments pinned to the cards they concern,
positioned on the canvas rather than listed in a sidebar. Comments carry `open`, `answered`,
`rejected`, `resolved`.

- Review agent and its fifteen deterministic checks: `packages/core/src/review.ts`
- Comment pins on the canvas: `apps/web/src/features/whiteboard/CommentPins.tsx`
- The deterministic checks run whether or not the model answers, so an OpenAI outage still
  produces a complete finding set rather than a partial one.
- See it: open a board and press **Run AI review**.

### c) Revision loop

Replying to a comment moves it to `answered`; rejecting records why; editing the card the comment
concerns and re-running review resolves it or restates it. Status transitions and the reconciliation
between rounds happen in one place — a `SECURITY DEFINER` RPC — so the client cannot invent a state.

- Reconciliation: `finalize_review_session` in `supabase/migrations/0012_review_freeze_and_comment_rpcs.sql`
- End-to-end proof: `apps/web/e2e/review-resolution.spec.ts`, `apps/web/e2e/review-iterate.spec.ts`

### d) Submit to a frozen spec

**Submit** compiles the canvas to a specification, canonicalises it (RFC 8785), hashes it, and
stores it immutably. Later canvas edits cannot change a frozen spec: the spec holds its own copy of
the graph and its own hash, and the board's revision moves on independently.

- Compiler: `packages/core/src/compiler.ts`
- Freeze: `freeze_whiteboard_spec` in `supabase/migrations/0012_review_freeze_and_comment_rpcs.sql`
- A frozen spec you can read: `generated-agents/inbound-import-receiving/v001/spec.snapshot.json`
- Proof it does not drift: `apps/web/e2e/freeze-spec.spec.ts`, and the `spec snapshot` step of
  `pnpm verify`

---

## Task 2 — Spec to self-healing agent

### Build a skeleton

`packages/agent-kit` is everything a generated agent sees and nothing a customer owns: the agent
contract, step recording, evidence, the tool surface, and the reserve-dispatch-complete protocol
that makes an external action safe across replay. A generated agent may import
`@meridian/agent-kit/contracts` and `@meridian/core/schemas` and nothing else, so it cannot reach a
provider SDK, the database, the filesystem, or the wall clock.

That the skeleton is genuinely reusable is not asserted — see Task 3's second deployment below.

### Generate an initial agent

A Codex/Cursor skill takes a frozen spec plus the skeleton and writes five files.

- Skill: `.codex/skills/spec-to-agent/SKILL.md`
- Operator commands: `pnpm agent:reserve`, `pnpm agent:export-spec`, `pnpm agent:finalize`
- Output: `generated-agents/inbound-import-receiving/v001/`

Every version records the spec hash it was generated from and the Git commit that contains its
files, and `pnpm agent:verify-manifest` re-derives both rather than trusting the record.

### Write an eval suite

Twenty-one cases across two deployments, each tracing to a statement on the board it came from.

- Cases: `examples/inbound-import-receiving/evals` (16), `examples/vendor-coi-renewal/evals` (5)
- Harness: `packages/evals`
- Run: `pnpm evals`, or `pnpm exec tsx scripts/run-evals.ts --agent vendor-coi-renewal`

### Close the loop

A failing suite is classified before anything is changed. A `policy_gap` — the specification does not
decide the case — stops the loop and records a comment on the board, because a coding agent inventing
policy is the exact failure this project exists to prevent. Everything else is repairable, and a
repair reserves a new version rather than editing a released one.

- Repair skill: `.codex/skills/eval-repair/SKILL.md`
- Classification: `packages/evals/src/classify-failure.ts`
- Reserve a repair: `pnpm agent:reserve-repair`

---

## Task 3 — End-to-end example

The customer workflow is the Inbound Import Receiving SOP. Where the SOP and the PRD disagree, the
SOP governs the process and the PRD governs the platform; the reasoning is in `docs/DECISIONS.md`.

| Step                       | State                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| 1. Whiteboard the process  | Board seeded and frozen; **the incomplete-first pass is pending**                |
| 2. Two rounds of AI review | **Pending** — the loop works and is covered by e2e, not yet run as the narrative |
| 3. Frozen specification    | Done — `spec.snapshot.json`, hash `6ffaa3f2…`                                    |
| 4. Generate an agent       | Done — `v001`, generated through the skill                                       |
| 5. Evaluate and improve    | Done for correctness (16/16); the repair loop to a `v002` is pending             |

### Proving it generalises

The assignment asks for a skeleton that "shouldn't be specific to one customer's process." A single
example cannot show that, so there is a second deployment: **Vendor Insurance Certificate Renewal**.
It shares no domain type with receiving — vendors, policies, coverage limits, expiry dates — and it
went through the identical path: seed, compile, freeze, create agent, create version, finalize
against a verified Git commit, approve, activate, evaluate.

```
deployment_key           | status   | spec_hash     | evals
inbound-import-receiving | approved | 6ffaa3f274b8  | 16/16
vendor-coi-renewal       | approved | cbcac0172a5e  |   5/5
```

Building it is what forced the last domain assumptions out of the platform: a compiler that emitted
one customer's decision schema for every board, an eval harness that read one customer's mailbox,
and correlation that could only recognise a container number. Those are recorded in
`docs/DECISIONS.md`.

---

## What is not done

- **The incomplete-first board and the two review rounds** (Task 3, steps 1–2). The mechanism works
  and is covered by `review-resolution.spec.ts` and `review-iterate.spec.ts`; what is missing is the
  narrative run where a deliberately under-specified board is interviewed into a complete one.
- **A `v002` produced by the repair loop.** `v001` passes its suite, so no repair has been forced.
- **Live Gmail.** Intake runs against a fixture mailbox by default. The Composio Gmail path exists
  (`pnpm connect-gmail`, `pnpm process-inbox`) and is unexercised without credentials.

## Verifying all of it

```bash
pnpm verify        # 20 gates: lint, format, types, build, tree, spec snapshot, unit, db, temporal, audits
pnpm verify:e2e    # the Playwright suite against a running stack
pnpm demo          # the seeded board through to an executed run
```
