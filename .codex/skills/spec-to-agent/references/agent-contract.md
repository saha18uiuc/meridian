# The generated-agent contract

Everything a generated agent is allowed to depend on, and why the boundary is where it is.

## Imports

A file under `generated-agents/**` may import:

- `@meridian/agent-kit/contracts` — types and pure helpers only.
- `zod` — for the input and decision schemas.
- Its own siblings: `./rules.js`, `./prompts.js`.

Nothing else. This is enforced by an ESLint `no-restricted-imports` rule, so a violation fails
`pnpm lint` rather than failing mysteriously at runtime.

The reason is the Temporal workflow sandbox. `AgentDefinition.run` executes inside it, where there
is no filesystem, no network, no `process`, and no dynamic `import()`. A provider SDK reached from
generated code would either fail to bundle or, worse, bundle and then behave differently on replay.
`@meridian/agent-kit/contracts` is curated to contain nothing that can do either.

`packages/agent-kit` also exports live adapters, Supabase-backed recording, and Storage helpers
from its root entry point. Those exist for the worker and the operator scripts. Importing
`@meridian/agent-kit` (rather than `@meridian/agent-kit/contracts`) from generated code is a lint
error for exactly that reason.

## Determinism

Banned outright, and checked by lint:

- `Date.now()`, `new Date()` — use `context.clock.now()`.
- `Math.random()` — derive from `context.executionId` or a step key if you need a distinct value.
- `setTimeout`, `setInterval` — the workflow controls time.
- `process.env` — configuration arrives in `context.config`.

A workflow is replayed. Any of the above produces a different answer on replay than it did on the
original run, and Temporal will fail the replay as non-deterministic. The clock, the config, and the
tool registry are injected precisely so the same inputs produce the same decisions forever.

## Tools

```ts
context.toolRegistry.mailbox; // search, fetch a thread, download attachments, draft, send
context.toolRegistry.documents; // extract text, extract fields against a named schema, normalize
context.toolRegistry.browser; // open, extract text, download, screenshot
context.toolRegistry.humanHandoff; // request a decision, wait for it
```

Each is an activity-backed proxy inside a workflow, and a direct adapter inside the eval harness.
The generated agent cannot tell which, and must not try to find out.

`capabilities` on the context lists what this version was granted. Calling a tool outside the grant
throws `CapabilityDeniedError`. Check `capabilities` before offering an optional behaviour rather
than catching the error.

## Recording

```ts
const step = await context.recorder.startStep({
  nodeId, // the spec node this step implements, or null
  stepKey: 'extract-invoice', // the kind of step
  stepInstanceKey: `extract-invoice:${invoiceNumber}`, // this specific step
  sequenceNo: 3, // display ordering only
});
await context.recorder.completeStep(step.stepExecutionId, { invoiceNumber, goods: goods.length });
```

`stepInstanceKey` is logical identity. Two attempts at the same logical step share it and differ by
`attemptNo`; the database enforces that with a unique constraint on
`(execution_id, step_instance_key, attempt_no)`. `sequenceNo` is what the UI sorts by and carries no
identity at all — do not derive it from anything meaningful and do not assume it is unique.

Evidence:

```ts
await context.recorder.appendEvidence(step.stepExecutionId, payload, { eventKey: 'invoice:1024' });
```

`eventKey` makes the evidence idempotent across replays. Omit it only for events that genuinely
should appear once per attempt.

## External actions

Every effect the outside world can observe follows the same three phases:

```ts
const action = await context.recorder.reserveAction(step.stepExecutionId, 'email.send', payload);
await context.recorder.dispatchAction(action.executionActionId);
const sent = await context.toolRegistry.mailbox.sendMessage({
  ...mail,
  markerToken: action.markerToken,
});
await context.recorder.completeAction(action.executionActionId, {
  status: 'succeeded',
  providerActionId: sent.providerMessageId,
});
```

The idempotency key is derived by the recorder from
`(executionId, stepInstanceKey, actionType, payload)`, so replaying the identical step finds the
existing reservation instead of creating a second one. `reserveAction` returns the existing row when
the key already exists, and a run that dies between `dispatchAction` and `completeAction` leaves the
action in `dispatched`, which the runtime reconciles by searching the provider for the marker token.

Do not invent your own idempotency key, and do not skip `dispatchAction` because the call is
"probably fine". The gap between dispatch and completion is the only place the system can later
prove whether a send escaped.

## The decision

`run()` returns a value matching `AgentDecisionSchema`:

```ts
{
  outcome: 'ready' | 'needs_information' | 'manual_review' | 'rejected' | 'completed',
  businessKey: string | null,
  reason: string,
  shipmentSummary: { containerNumber, mawb, invoiceNumbers, batchNumbers, goodsCount, validGoodsCount },
  missingInformation: string[],
  validationFailures: { scope, key, field, message }[],
  emailResponse: { subject, body, recipient } | null,
}
```

`manual_review` is the honest answer whenever the spec does not decide the case. It is not a
failure mode to be avoided; it is the mechanism by which the system refuses to invent policy.

Throwing from `run()` means the _machinery_ broke — a tool was unreachable, a document was
unparseable after every retry. It never means "the business rules say no". Use `rejected` for that.

## manifest.json

```json
{
  "manifestVersion": 1,
  "deploymentKey": "inbound-import-receiving",
  "versionNo": 1,
  "codePath": "generated-agents/inbound-import-receiving/v001",
  "specId": "<uuid>",
  "specHash": "<64 hex>",
  "specVersion": 1,
  "files": ["agent.ts", "rules.ts", "prompts.ts", "manifest.json", "spec.snapshot.json"],
  "capabilities": ["mail.read", "mail.send", "document.extract", "human.handoff"],
  "generatedAt": "<ISO 8601>",
  "generator": { "skill": "spec-to-agent", "model": "<the model you are>" },
  "toolkitVersions": { "composioGmailToolkit": "<concrete version>" },
  "validation": {
    "commands": ["pnpm lint", "pnpm typecheck", "pnpm test:unit"],
    "evalCaseKeys": ["case-01"]
  }
}
```

`toolkitVersions` must hold concrete resolved versions. The literal `latest` is rejected by the
schema, by `pnpm verify`, and by `agent:finalize`, because a recorded `latest` makes the whole
lineage unreproducible: the same SHA would mean a different toolkit next week. Read the resolved
values from `.meridian/resolved-versions.json`, which `pnpm preflight` writes.

## spec.snapshot.json

The exported spec, copied without reformatting. `agent:finalize` hashes the committed file and
requires it to equal `frozen_specs.spec_hash`. Re-indenting it changes the bytes but not the
canonical hash, so it will still pass — but copy it verbatim anyway, so a reviewer diffing the
snapshot against the export sees nothing at all.
