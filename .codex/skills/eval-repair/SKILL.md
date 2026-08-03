---
name: eval-repair
description: Diagnose and repair a failing Meridian eval suite by reserving a new agent version. Use when `pnpm evals` reports failures and the operator asks for a repair.
---

# eval-repair

Read a failing eval report, work out what kind of failure it is, and fix only the kinds you are
allowed to fix.

The single most important thing this skill does is **refuse**. Three of the four failure classes are
yours to repair. The fourth — a policy gap — means the frozen specification does not decide the case
the eval asserts. Repairing that would mean writing business policy into generated code where no
domain expert ever reviews it, and it would make the eval suite green by making it meaningless.

## Read the failure before touching anything

```bash
pnpm evals --agent-version <agentVersionId> --json
```

The report names, per case, the assertions that failed and a `failureClass`. Do not take the
classification on faith — it is a heuristic over assertion names and error types. Confirm it against
the recorded run:

```sql
select step_key, step_instance_key, attempt_no, status, error_json
  from execution_steps where execution_id = '<executionId>' order by sequence_no, attempt_no;

select event_type, event_key, payload_json
  from execution_events where execution_id = '<executionId>' order by event_id;
```

`references/failure-types.md` describes each class with a worked example. Read it before deciding.

## What you may repair

| Class                 | Repair?  | What it means                                                                |
| --------------------- | -------- | ---------------------------------------------------------------------------- |
| `extraction`          | Yes      | The document tool returned the wrong fields, or the agent read them wrongly. |
| `implementation`      | Yes      | The rules are stated in the spec but coded incorrectly.                      |
| `tool_infrastructure` | Report   | A tool was unreachable or misconfigured. Not a code defect.                  |
| `policy_gap`          | **Stop** | The spec does not decide this case.                                          |

On `policy_gap`, `pnpm evals` has already recorded the gap: a completed system-origin review session
plus a blocking root comment on the board, carrying the eval run and the failure key. It exits with
code 5. Your job at that point is to tell the operator which decision is undefined and which spec
node you looked at. Do not edit code. Do not edit the eval case. Do not edit the spec.

## How to repair

Never edit an already-evaluated version's folder. Reserve a new one:

```bash
pnpm agent:reserve-repair --parent <agentVersionId>
```

This allocates the next version number with `parent_agent_version_id` set to the parent, creates the
new `code_path`, and copies the parent's five files into it. Apply your patch there.

Then, exactly as in generation:

```bash
bash .codex/skills/spec-to-agent/scripts/verify.sh
pnpm agent:finalize --agent-version <newAgentVersionId>
pnpm evals --agent-version <newAgentVersionId>
```

Run the **complete** suite, not just the case you fixed. A repair that fixes one case and breaks
another is not a repair, and only the full suite can tell you which one you made.

## The iteration bound

Three iterations, controlled by `EVAL_REPAIR_MAX_ITERATIONS`. On the fourth failure, stop and hand
back to the operator with what you learned.

The bound exists because a loop that keeps patching until the suite goes green will eventually find
a patch that satisfies the assertions without implementing the behaviour — special-casing an input,
widening a comparison, catching an error that should propagate. Three honest attempts and a clear
report beat ten attempts and a green suite nobody can trust.

## What you may never do

- Edit the frozen spec, or any file under `supabase/`.
- Edit the shared runtime: `packages/core`, `packages/agent-kit`, `packages/ops`, `apps/**`.
- Edit an eval case or its expected document to match the behaviour you produced. The case is the
  question; changing it to fit the answer is the one move that destroys the entire signal.
- Weaken, skip, or delete a test.
- Special-case a fixture by name, ID, or content inside `rules.ts` or `agent.ts`.
- Mutate a folder belonging to a version that has already been evaluated.
