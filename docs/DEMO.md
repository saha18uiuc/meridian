# Demo walkthrough

The full lifecycle, from an empty board to a rolled-back agent version. Every step runs against
deterministic mocks; no paid API key is needed.

Two terminals. Terminal A runs `pnpm dev` and blocks. Everything else runs in terminal B.

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
30. Download the spec. `shasum -a 256` of the file equals the displayed `spec_hash`.

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
