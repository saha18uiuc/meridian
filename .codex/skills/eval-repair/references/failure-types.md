# The four failure classes

Each class answers one question: _who is allowed to fix this?_ Get the class wrong in the permissive
direction and the repair loop starts writing business policy. That is the single worst outcome the
design guards against, so anything genuinely ambiguous is a `policy_gap` and the loop stops.

`packages/evals/src/classify-failure.ts` implements the heuristic. It classifies from the assertion
names and the thrown error type, which is enough to be right most of the time and not enough to be
trusted blindly. Always confirm against the recorded steps and events.

---

## `extraction`

**The document said one thing and the agent read another.**

The rule is implemented correctly; the input to it was wrong.

_Example._ Case 04 expects `needs_information` listing `ndcNumber` as missing for line 2 of invoice 1026. The run instead returns `ready`. Reading `execution_events` shows the extraction step recorded
`ndcNumber: "0378-1234-01"` for that line — but the PDF's NDC column is empty and that value is the
neighbouring registration number, picked up because the field mapping is off by one column.

_Repair._ Fix the field mapping in the extraction call or the normalization in `rules.ts`. Do not
change what `needs_information` means.

_Tell-tale signs._ `ExtractionError` or `ValidationError` thrown; the failing step's `step_key` is
`extract`; the decision's `shipmentSummary` disagrees with the fixture's actual contents.

---

## `implementation`

**The spec states the rule; the code gets it wrong.**

_Example._ Case 06 expects `rejected` because batch `B90X` appears on two invoices, and the frozen
spec's duplicate-batch Rule node says a batch may appear at most once per shipment. The run returns
`ready`. Reading `rules.ts` shows `duplicateBatchNumbers` compares batch numbers case-sensitively,
so `B90X` and `b90x` are treated as distinct.

_Repair._ Fix the comparison. The spec already told you the answer; the code just did not implement
it.

_Tell-tale signs._ A failing `outcome`, `missingFields`, or `businessKey` assertion where the spec
node the case's `specTrace` points at plainly states the expected behaviour. Also every failure of
`externalActions.noDuplicateSends`, `stepLineage.unique`, `retries`, and the `gitLineage.*`
assertions — those assert mechanical properties of the runtime contract, never business policy.

---

## `policy_gap`

**The spec does not decide this case.**

The eval asserts a behaviour that no node, rule, or edge in the frozen specification states. There
is no correct code change, because there is no agreed answer to encode.

_Example._ Case 09 sends a revised invoice 1024 whose line items differ from the original 1024
already on file. The case expects `manual_review`. The spec's deduplication Rule says invoices are
deduplicated by invoice number, and says nothing at all about what to happen when the same number
arrives with different contents. Silently keeping the first is a policy. Silently keeping the last
is a different policy. Escalating is a third. The specification picks none of them.

_Repair._ None. `pnpm evals` has already recorded the gap on the board — a completed system-origin
review session and a blocking root comment carrying the eval run ID, the failure key, and the agent
version — and exited with code 5. Report which decision is undefined and which node you checked.

_Tell-tale signs._ The case carries `"knownGap": true`. Or: you find yourself about to write a
comparison, threshold, precedence order, or tie-break that you cannot point to a spec node for. That
feeling is the signal. Stop there.

---

## `tool_infrastructure`

**The environment broke, not the code.**

_Example._ Every case fails at the first extraction step with `ToolUnavailableError: documents`. The
attachment fixtures were never generated, so the mock document tool has nothing to read.

_Repair._ None in the agent. Fix the environment — regenerate fixtures, start the missing service,
correct the credential — and re-run. If it recurs deterministically, it is probably an
`implementation` failure wearing a tool error's clothing: check whether the agent is asking for a
file it should have known was absent.

_Tell-tale signs._ `ToolUnavailableError`, `RetryableToolError`, `RateLimitError`, or
`TransientNetworkError`; many cases failing identically at the same step; the same suite passing on
a colleague's machine.

---

## When two classes both fit

Take the more restrictive one. The ordering, from most to least permissive:

```
extraction  <  implementation  <  tool_infrastructure  <  policy_gap
```

A case that looks like an `implementation` failure but whose spec node turns out to be silent is a
`policy_gap`. Classifying it as `implementation` and "fixing" it writes an unreviewed policy into
generated code, and the resulting green suite hides the fact that nobody ever decided the question.
