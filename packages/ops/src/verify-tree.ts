import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from './lib/state.js';

/**
 * Assert the repository is the tree the plan specifies.
 *
 * Two separate failures are checked, because they mean different things. A **missing** path means
 * something was never built. An **undeclared extra** path means the tree drifted — usually a
 * scratch file, occasionally a whole subsystem someone added without writing down why. Extras are
 * therefore not banned outright; they are banned unless they appear in `DECLARED_ADDITIONS`, whose
 * entries each carry the reason they exist. That keeps the check honest without making every
 * justified addition a lie in a comment somewhere else.
 */

export const REQUIRED_PATHS: readonly string[] = [
  '.nvmrc',
  '.gitignore',
  '.env.example',
  '.prettierrc.json',
  '.prettierignore',
  'eslint.config.mjs',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'vitest.workspace.ts',
  'README.md',
  '.github/workflows/ci.yml',
  '.meridian/.gitkeep',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/next.config.ts',
  'apps/web/next-env.d.ts',
  'apps/web/playwright.config.ts',
  'apps/web/vitest.component.config.ts',
  'apps/web/vitest.service.config.ts',
  'apps/web/e2e/fixtures.ts',
  'apps/web/e2e/auth.spec.ts',
  'apps/web/e2e/whiteboard-edit-save.spec.ts',
  'apps/web/e2e/whiteboard-conflict.spec.ts',
  'apps/web/e2e/review-iterate.spec.ts',
  'apps/web/e2e/stale-review-indicator.spec.ts',
  'apps/web/e2e/freeze-spec.spec.ts',
  'apps/web/e2e/agent-lifecycle.spec.ts',
  'apps/web/e2e/agent-activation-rollback.spec.ts',
  'apps/web/e2e/execution-viewer.spec.ts',
  'apps/web/test/setup-component.ts',
  'apps/web/test/setup-service.ts',
  'apps/web/test/component/inspector.test.tsx',
  'apps/web/test/component/canvas-cards.test.tsx',
  'apps/web/test/component/thread-item.test.tsx',
  'apps/web/test/component/review-status-badge.test.tsx',
  'apps/web/test/component/step-table.test.tsx',
  'apps/web/test/component/event-feed.test.tsx',
  'apps/web/test/service/save-delta.test.ts',
  'apps/web/test/service/review-create.test.ts',
  'apps/web/test/service/review-finalize.test.ts',
  'apps/web/test/service/review-reconcile.test.ts',
  'apps/web/test/service/comment-actions.test.ts',
  'apps/web/test/service/freeze.test.ts',
  'apps/web/test/service/agents.test.ts',
  'apps/web/test/service/agent-versions.test.ts',
  'apps/web/test/service/activation.test.ts',
  'apps/web/test/service/executions.test.ts',
  'apps/web/test/service/intake.test.ts',
  'apps/web/test/service/service-role-substitution.test.ts',
  'apps/web/src/middleware.ts',
  'apps/web/src/app/layout.tsx',
  'apps/web/src/app/page.tsx',
  'apps/web/src/app/globals.css',
  'apps/web/src/app/error.tsx',
  'apps/web/src/app/not-found.tsx',
  'apps/web/src/app/login/page.tsx',
  'apps/web/src/app/boards/page.tsx',
  'apps/web/src/app/boards/[whiteboardId]/page.tsx',
  'apps/web/src/app/specs/[specId]/page.tsx',
  'apps/web/src/app/agents/page.tsx',
  'apps/web/src/app/agents/[agentId]/page.tsx',
  'apps/web/src/app/executions/page.tsx',
  'apps/web/src/app/executions/[executionId]/page.tsx',
  'apps/web/src/app/api/health/route.ts',
  'apps/web/src/app/api/whiteboards/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/delta/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/status/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/reviews/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/freeze/route.ts',
  'apps/web/src/app/api/whiteboards/[whiteboardId]/assumptions/route.ts',
  'apps/web/src/app/api/reviews/[reviewSessionId]/route.ts',
  'apps/web/src/app/api/reviews/[reviewSessionId]/comments/route.ts',
  'apps/web/src/app/api/comments/[commentId]/replies/route.ts',
  'apps/web/src/app/api/comments/[commentId]/reject/route.ts',
  'apps/web/src/app/api/comments/[commentId]/apply-patch/route.ts',
  'apps/web/src/app/api/comments/[commentId]/assumption/route.ts',
  'apps/web/src/app/api/specs/[specId]/route.ts',
  'apps/web/src/app/api/agents/route.ts',
  'apps/web/src/app/api/agents/[agentId]/route.ts',
  'apps/web/src/app/api/agents/[agentId]/status/route.ts',
  'apps/web/src/app/api/agents/[agentId]/activation/route.ts',
  'apps/web/src/app/api/agents/[agentId]/version-reservations/route.ts',
  'apps/web/src/app/api/agent-versions/[agentVersionId]/route.ts',
  'apps/web/src/app/api/agent-versions/[agentVersionId]/transition/route.ts',
  'apps/web/src/app/api/agent-versions/[agentVersionId]/eval-runs/route.ts',
  'apps/web/src/app/api/agent-versions/[agentVersionId]/eval-runs/[evalRunId]/route.ts',
  'apps/web/src/app/api/executions/route.ts',
  'apps/web/src/app/api/executions/[executionId]/route.ts',
  'apps/web/src/app/api/executions/[executionId]/steps/route.ts',
  'apps/web/src/app/api/executions/[executionId]/events/route.ts',
  'apps/web/src/app/api/executions/[executionId]/actions/route.ts',
  'apps/web/src/app/api/executions/[executionId]/human-decisions/route.ts',
  'apps/web/src/app/api/live-runs/route.ts',
  'apps/web/src/features/whiteboard/Canvas.tsx',
  'apps/web/src/features/whiteboard/Inspector.tsx',
  'apps/web/src/features/whiteboard/CommentPins.tsx',
  'apps/web/src/features/whiteboard/ReviewStatusBadge.tsx',
  'apps/web/src/features/whiteboard/RenameBoardField.tsx',
  'apps/web/src/features/whiteboard/ConflictBanner.tsx',
  'apps/web/src/features/whiteboard/useGraphStore.ts',
  'apps/web/src/features/whiteboard/buildDelta.ts',
  'apps/web/src/features/whiteboard/useSaveDelta.ts',
  'apps/web/src/features/whiteboard/edgeUtils.ts',
  'apps/web/src/features/whiteboard/nodes/InputCard.tsx',
  'apps/web/src/features/whiteboard/nodes/ActionCard.tsx',
  'apps/web/src/features/whiteboard/nodes/RuleCard.tsx',
  'apps/web/src/features/whiteboard/nodes/OutcomeCard.tsx',
  'apps/web/src/features/review/ReviewButton.tsx',
  'apps/web/src/features/review/ThreadList.tsx',
  'apps/web/src/features/review/ThreadItem.tsx',
  'apps/web/src/features/review/UnresolvedCounter.tsx',
  'apps/web/src/features/review/ReplyBox.tsx',
  'apps/web/src/features/review/RejectDialog.tsx',
  'apps/web/src/features/review/ApplyPatchButton.tsx',
  'apps/web/src/features/review/AssumptionDialog.tsx',
  'apps/web/src/features/spec/FreezeButton.tsx',
  'apps/web/src/features/spec/UnresolvedBlockerWarning.tsx',
  'apps/web/src/features/spec/DismissedFindings.tsx',
  'apps/web/src/features/spec/StaleReviewWarning.tsx',
  'apps/web/src/features/spec/SpecViewer.tsx',
  'apps/web/src/features/agents/AgentList.tsx',
  'apps/web/src/features/agents/CreateAgentDialog.tsx',
  'apps/web/src/features/agents/AgentVersionTable.tsx',
  'apps/web/src/features/agents/LineageBadge.tsx',
  'apps/web/src/features/agents/ReserveVersionPanel.tsx',
  'apps/web/src/features/agents/ApproveButton.tsx',
  'apps/web/src/features/agents/ActivationControls.tsx',
  'apps/web/src/features/executions/ExecutionList.tsx',
  'apps/web/src/features/executions/ExecutionSummary.tsx',
  'apps/web/src/features/executions/StepTable.tsx',
  'apps/web/src/features/executions/EventFeed.tsx',
  'apps/web/src/features/executions/ActionPanel.tsx',
  'apps/web/src/features/executions/EvalDiff.tsx',
  'apps/web/src/server/supabase/browser-client.ts',
  'apps/web/src/server/supabase/server-client.ts',
  'apps/web/src/server/supabase/service-client.ts',
  'apps/web/src/server/auth/require-user.ts',
  'apps/web/src/server/http/error-map.ts',
  'apps/web/src/server/http/json.ts',
  'apps/web/src/server/repositories/whiteboards.ts',
  'apps/web/src/server/repositories/nodes.ts',
  'apps/web/src/server/repositories/edges.ts',
  'apps/web/src/server/repositories/reviews.ts',
  'apps/web/src/server/repositories/comments.ts',
  'apps/web/src/server/repositories/specs.ts',
  'apps/web/src/server/repositories/agents.ts',
  'apps/web/src/server/repositories/agent-versions.ts',
  'apps/web/src/server/repositories/executions.ts',
  'apps/web/src/server/repositories/execution-steps.ts',
  'apps/web/src/server/repositories/execution-events.ts',
  'apps/web/src/server/repositories/execution-actions.ts',
  'apps/web/src/server/services/save-whiteboard-delta.ts',
  'apps/web/src/server/services/assemble-snapshot.ts',
  'apps/web/src/server/services/run-review.ts',
  'apps/web/src/server/services/review-reconcile.ts',
  'apps/web/src/server/services/comment-actions.ts',
  'apps/web/src/server/services/freeze-spec.ts',
  'apps/web/src/server/services/agents.ts',
  'apps/web/src/server/services/agent-versions.ts',
  'apps/web/src/server/services/activation.ts',
  'apps/web/src/server/services/eval-runs.ts',
  'apps/web/src/server/services/executions.ts',
  'apps/web/src/server/services/intake.ts',
  'apps/web/src/server/services/ownership.ts',
  'apps/backend/package.json',
  'apps/backend/tsconfig.json',
  'apps/backend/vitest.temporal.config.ts',
  'apps/backend/src/temporal/worker.ts',
  'apps/backend/src/temporal/client.ts',
  'apps/backend/src/temporal/signals.ts',
  'apps/backend/src/temporal/task-queue.ts',
  'apps/backend/src/temporal/health-server.ts',
  'apps/backend/src/temporal/workflows/index.ts',
  'apps/backend/src/temporal/workflows/receiving-workflow.ts',
  'apps/backend/src/temporal/workflows/sequence-plan.ts',
  'apps/backend/src/temporal/workflows/tool-proxies.ts',
  'apps/backend/src/temporal/activities/index.ts',
  'apps/backend/src/temporal/activities/mail.ts',
  'apps/backend/src/temporal/activities/documents.ts',
  'apps/backend/src/temporal/activities/browser.ts',
  'apps/backend/src/temporal/activities/model.ts',
  'apps/backend/src/temporal/activities/execution-recorder.ts',
  'apps/backend/src/temporal/activities/actions.ts',
  'apps/backend/src/start-live-run.ts',
  'apps/backend/test/receiving-workflow.test.ts',
  'apps/backend/test/signals.test.ts',
  'apps/backend/test/retry-steps.test.ts',
  'apps/backend/test/parallel-sequence.test.ts',
  'apps/backend/test/registry-bundle.test.ts',
  'apps/backend/test/workflow-determinism.test.ts',
  'apps/backend/test/action-idempotency.test.ts',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/src/index.ts',
  'packages/core/src/schemas.ts',
  'packages/core/src/hashing.ts',
  'packages/core/src/graph.ts',
  'packages/core/src/review.ts',
  'packages/core/src/issue-key.ts',
  'packages/core/src/compiler.ts',
  'packages/core/src/env.ts',
  'packages/core/src/logging.ts',
  'packages/core/src/database.types.ts',
  'packages/core/src/schemas/primitives.ts',
  'packages/core/src/schemas/node.ts',
  'packages/core/src/schemas/edge.ts',
  'packages/core/src/schemas/board.ts',
  'packages/core/src/schemas/delta.ts',
  'packages/core/src/schemas/review.ts',
  'packages/core/src/schemas/comment.ts',
  'packages/core/src/schemas/comment-metadata.ts',
  'packages/core/src/schemas/spec.ts',
  'packages/core/src/schemas/agent.ts',
  'packages/core/src/schemas/agent-version.ts',
  'packages/core/src/schemas/execution.ts',
  'packages/core/src/schemas/step.ts',
  'packages/core/src/schemas/event.ts',
  'packages/core/src/schemas/action.ts',
  'packages/core/src/schemas/decision.ts',
  'packages/core/src/schemas/eval-case.ts',
  'packages/core/src/schemas/build-manifest.ts',
  'packages/core/test/hashing.golden.test.ts',
  'packages/core/test/hashing.jcs-conformance.test.ts',
  'packages/core/test/hashing.numbers.test.ts',
  'packages/core/test/hashing.jsonb-roundtrip.test.ts',
  'packages/core/test/graph.test.ts',
  'packages/core/test/review.test.ts',
  'packages/core/test/issue-key.test.ts',
  'packages/core/test/compiler.test.ts',
  'packages/core/test/compiler.assumptions.test.ts',
  'packages/core/test/schemas.test.ts',
  'packages/core/test/schemas.primitives.test.ts',
  'packages/core/test/env.test.ts',
  'packages/core/test/helpers/db.ts',
  'packages/core/test/helpers/factories.ts',
  'packages/core/test/db/whiteboards-rls.test.ts',
  'packages/core/test/db/graph-write-path.test.ts',
  'packages/core/test/db/delta-validation.test.ts',
  'packages/core/test/db/delta-concurrency.test.ts',
  'packages/core/test/db/delta-noop.test.ts',
  'packages/core/test/db/edge-lineage.test.ts',
  'packages/core/test/db/review-sessions.test.ts',
  'packages/core/test/db/review-finalize-idempotency.test.ts',
  'packages/core/test/db/comments-invariants.test.ts',
  'packages/core/test/db/comments-anchor-snapshot.test.ts',
  'packages/core/test/db/comments-metadata.test.ts',
  'packages/core/test/db/comments-issue-key.test.ts',
  'packages/core/test/db/comments-lifecycle.test.ts',
  'packages/core/test/db/policy-gap-lineage.test.ts',
  'packages/core/test/db/frozen-specs.test.ts',
  'packages/core/test/db/frozen-specs-unresolved.test.ts',
  'packages/core/test/db/freeze-concurrency.test.ts',
  'packages/core/test/db/agents-lifecycle.test.ts',
  'packages/core/test/db/agent-version-allocation.test.ts',
  'packages/core/test/db/agent-version-gate.test.ts',
  'packages/core/test/db/agent-version-lineage.test.ts',
  'packages/core/test/db/agent-activation.test.ts',
  'packages/core/test/db/executions.test.ts',
  'packages/core/test/db/execution-workflow-identity.test.ts',
  'packages/core/test/db/parallel-steps.test.ts',
  'packages/core/test/db/events-append-only.test.ts',
  'packages/core/test/db/execution-actions.test.ts',
  'packages/core/test/db/storage-policies.test.ts',
  'packages/core/test/db/rls-lineage.test.ts',
  'packages/core/test/db/scale-100.test.ts',
  'packages/core/test/db/multi-agent.test.ts',
  'packages/agent-kit/package.json',
  'packages/agent-kit/tsconfig.json',
  'packages/agent-kit/src/index.ts',
  'packages/agent-kit/src/contracts.ts',
  'packages/agent-kit/src/agent.ts',
  'packages/agent-kit/src/context.ts',
  'packages/agent-kit/src/runner.ts',
  'packages/agent-kit/src/registry.ts',
  'packages/agent-kit/src/errors.ts',
  'packages/agent-kit/src/capabilities.ts',
  'packages/agent-kit/src/idempotency.ts',
  'packages/agent-kit/src/storage.ts',
  'packages/agent-kit/src/chunk.ts',
  'packages/agent-kit/src/tools/index.ts',
  'packages/agent-kit/src/tools/mailbox.ts',
  'packages/agent-kit/src/tools/browser.ts',
  'packages/agent-kit/src/tools/documents.ts',
  'packages/agent-kit/src/tools/human-handoff.ts',
  'packages/agent-kit/src/tools/factory.ts',
  'packages/agent-kit/src/tools/mock/mailbox.ts',
  'packages/agent-kit/src/tools/mock/browser.ts',
  'packages/agent-kit/src/tools/mock/documents.ts',
  'packages/agent-kit/src/tools/live/composio-mailbox.ts',
  'packages/agent-kit/src/tools/live/playwright-browser.ts',
  'packages/agent-kit/src/tools/live/openai-documents.ts',
  'packages/agent-kit/src/recording/recorder.ts',
  'packages/agent-kit/src/recording/steps.ts',
  'packages/agent-kit/src/recording/events.ts',
  'packages/agent-kit/src/recording/actions.ts',
  'packages/agent-kit/test/recorder.test.ts',
  'packages/agent-kit/test/parallel-steps.test.ts',
  'packages/agent-kit/test/capabilities.test.ts',
  'packages/agent-kit/test/idempotency.test.ts',
  'packages/agent-kit/test/chunk.test.ts',
  'packages/agent-kit/test/mailbox-mock.test.ts',
  'packages/agent-kit/test/mailbox-live-guard.test.ts',
  'packages/agent-kit/test/documents.test.ts',
  'packages/agent-kit/test/browser-allowlist.test.ts',
  'packages/agent-kit/test/errors.test.ts',
  'packages/evals/package.json',
  'packages/evals/tsconfig.json',
  'packages/evals/src/index.ts',
  'packages/evals/src/case-schema.ts',
  'packages/evals/src/run-suite.ts',
  'packages/evals/src/assertions.ts',
  'packages/evals/src/report.ts',
  'packages/evals/src/classify-failure.ts',
  'packages/evals/test/assertions.test.ts',
  'packages/evals/test/classify-failure.test.ts',
  'packages/evals/test/run-suite.test.ts',
  'packages/evals/test/policy-gap.test.ts',
  'packages/ops/package.json',
  'packages/ops/tsconfig.json',
  'packages/ops/src/index.ts',
  'packages/ops/src/env.ts',
  'packages/ops/src/preflight.ts',
  'packages/ops/src/check-ports.ts',
  'packages/ops/src/resolve-versions.ts',
  'packages/ops/src/bootstrap.ts',
  'packages/ops/src/dev-infra.ts',
  'packages/ops/src/stop-local.ts',
  'packages/ops/src/health-check.ts',
  'packages/ops/src/gen-types.ts',
  'packages/ops/src/seed-demo.ts',
  'packages/ops/src/run-evals.ts',
  'packages/ops/src/process-inbox.ts',
  'packages/ops/src/connect-gmail.ts',
  'packages/ops/src/reserve-agent-version.ts',
  'packages/ops/src/export-frozen-spec.ts',
  'packages/ops/src/finalize-agent-version.ts',
  'packages/ops/src/verify-build-manifest.ts',
  'packages/ops/src/reserve-repair-version.ts',
  'packages/ops/src/generate-registry.ts',
  'packages/ops/src/verify-tree.ts',
  'packages/ops/src/verify.ts',
  'packages/ops/src/verify-e2e.ts',
  'packages/ops/src/demo-run.ts',
  'packages/ops/src/intake/index.ts',
  'packages/ops/src/intake/extract-business-key.ts',
  'packages/ops/src/intake/signal-with-start.ts',
  'packages/ops/src/intake/reconcile-queued-executions.ts',
  'packages/ops/src/lib/git.ts',
  'packages/ops/src/lib/supabase.ts',
  'packages/ops/src/lib/proc.ts',
  'packages/ops/src/lib/state.ts',
  'packages/ops/test/check-ports.test.ts',
  'packages/ops/test/git.test.ts',
  'packages/ops/test/finalize-agent-version.test.ts',
  'packages/ops/test/verify-build-manifest.test.ts',
  'packages/ops/test/generate-registry.test.ts',
  'packages/ops/test/resolve-versions.test.ts',
  'packages/ops/test/extract-business-key.test.ts',
  'packages/ops/test/signal-with-start.test.ts',
  'packages/ops/test/reconcile-queued-executions.test.ts',
  'packages/ops/test/state.test.ts',
  'generated-agents/package.json',
  'generated-agents/tsconfig.json',
  'generated-agents/index.ts',
  'generated-agents/inbound-import-receiving/v001/agent.ts',
  'generated-agents/inbound-import-receiving/v001/rules.ts',
  'generated-agents/inbound-import-receiving/v001/prompts.ts',
  'generated-agents/inbound-import-receiving/v001/manifest.json',
  'generated-agents/inbound-import-receiving/v001/spec.snapshot.json',
  '.codex/skills/spec-to-agent/SKILL.md',
  '.codex/skills/spec-to-agent/references/agent-contract.md',
  '.codex/skills/spec-to-agent/scripts/verify.sh',
  '.codex/skills/eval-repair/SKILL.md',
  '.codex/skills/eval-repair/references/failure-types.md',
  '.codex/skills/eval-repair/scripts/run-suite.sh',
  'supabase/config.toml',
  'supabase/seed.sql',
  'supabase/storage-policies.sql',
  'supabase/migrations/0001_extensions_and_helpers.sql',
  'supabase/migrations/0002_authoring_tables.sql',
  'supabase/migrations/0003_whiteboard_rpcs.sql',
  'supabase/migrations/0004_review_and_comments.sql',
  'supabase/migrations/0005_frozen_specs.sql',
  'supabase/migrations/0006_agents_and_versions.sql',
  'supabase/migrations/0007_execution_tables.sql',
  'supabase/migrations/0008_execution_actions.sql',
  'supabase/migrations/0009_release_pointer_constraints.sql',
  'supabase/migrations/0010_rls_and_privileges.sql',
  'supabase/migrations/0011_lifecycle_and_invariant_triggers.sql',
  'supabase/migrations/0012_review_freeze_and_comment_rpcs.sql',
  'supabase/migrations/0013_agent_execution_and_action_rpcs.sql',
  'supabase/migrations/0014_storage_and_seed_support.sql',
  'examples/inbound-import-receiving/board.seed.json',
  'examples/inbound-import-receiving/board.scale-100.json',
  'examples/inbound-import-receiving/evals/case-01.json',
  'examples/inbound-import-receiving/evals/case-02.json',
  'examples/inbound-import-receiving/evals/case-03.json',
  'examples/inbound-import-receiving/evals/case-04.json',
  'examples/inbound-import-receiving/evals/case-05.json',
  'examples/inbound-import-receiving/evals/case-06.json',
  'examples/inbound-import-receiving/evals/case-07.json',
  'examples/inbound-import-receiving/evals/case-08.json',
  'examples/inbound-import-receiving/evals/case-09.json',
  'examples/inbound-import-receiving/evals/case-10.json',
  'examples/inbound-import-receiving/evals/case-11.json',
  'examples/inbound-import-receiving/evals/case-12.json',
  'examples/inbound-import-receiving/evals/case-13.json',
  'examples/inbound-import-receiving/evals/case-14.json',
  'examples/inbound-import-receiving/evals/case-15.json',
  'examples/inbound-import-receiving/fixtures/emails/happy-path.eml',
  'examples/inbound-import-receiving/fixtures/emails/missing-fields.eml',
  'examples/inbound-import-receiving/fixtures/emails/duplicate-invoice.eml',
  'examples/inbound-import-receiving/fixtures/emails/missing-coa.eml',
  'examples/inbound-import-receiving/fixtures/emails/mawb-only.eml',
  'examples/inbound-import-receiving/fixtures/emails/no-business-key.eml',
  'examples/inbound-import-receiving/fixtures/emails/conflicting-keys.eml',
  'examples/inbound-import-receiving/fixtures/emails/late-followup.eml',
  'examples/inbound-import-receiving/fixtures/attachments/invoice-1024.pdf',
  'examples/inbound-import-receiving/fixtures/attachments/invoice-1025.pdf',
  'examples/inbound-import-receiving/fixtures/attachments/packing-list-1024.pdf',
  'examples/inbound-import-receiving/fixtures/attachments/coa-B77A.pdf',
  'examples/inbound-import-receiving/fixtures/attachments/coa-B77B.pdf',
  'examples/inbound-import-receiving/fixtures/attachments/scanned-invoice.pdf',
  'examples/inbound-import-receiving/fixtures/expected/case-01.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-02.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-03.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-04.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-05.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-06.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-07.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-08.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-09.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-10.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-11.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-12.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-13.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-14.expected.json',
  'examples/inbound-import-receiving/fixtures/expected/case-15.expected.json',
  'tsconfig.scripts.json',
  'scripts/preflight.ts',
  'scripts/check-ports.ts',
  'scripts/bootstrap.ts',
  'scripts/dev-infra.ts',
  'scripts/stop-local.ts',
  'scripts/health-check.ts',
  'scripts/gen-types.ts',
  'scripts/seed-demo.ts',
  'scripts/run-evals.ts',
  'scripts/process-inbox.ts',
  'scripts/connect-gmail.ts',
  'scripts/reserve-agent-version.ts',
  'scripts/export-frozen-spec.ts',
  'scripts/finalize-agent-version.ts',
  'scripts/verify-build-manifest.ts',
  'scripts/reserve-repair-version.ts',
  'scripts/generate-registry.ts',
  'scripts/verify-tree.ts',
  'scripts/verify.ts',
  'scripts/verify-e2e.ts',
  'scripts/demo-run.ts',
  'docs/PRD.md',
  'docs/ARCHITECTURE.md',
  'docs/DECISIONS.md',
  'docs/DEMO.md',
];

export const REQUIRED_MIGRATIONS = 14;
export const REQUIRED_EVAL_CASES = 15;

/**
 * Files present in the tree that the plan's listing does not name, each with the reason it exists.
 * An addition without an entry here fails the check.
 */
export const DECLARED_ADDITIONS: Readonly<Record<string, string>> = {
  'packages/ops/src/index.ts': 'barrel so apps/web and apps/backend can import the intake path',
  'packages/ops/src/lib/args.ts': 'shared CLI argument parser, extracted from six scripts',
  'packages/ops/src/lib/temporal.ts':
    'Temporal client singleton, the counterpart of lib/supabase.ts',
  'packages/ops/src/fixtures':
    'generators that reproduce the committed example boards, documents, and eval cases',
  'packages/ops/src/release-demo-agent.ts':
    'the operator gates for the demo agent — freeze, create, finalize, evaluate, approve, activate — run in order by pnpm seed so a fresh clone has an active version to demonstrate; it calls the same RPCs and the same finalize path a human operator would, rather than writing the rows directly',
  'packages/agent-kit/src/tools/reserved-send.ts':
    'the external-action protocol — reserve, dispatch, complete, reconcile — in the one place both runtimes reach: the Temporal activity delegates to it and the eval harness wraps its mailbox with it, so "send once" cannot come to mean two different things, and no generated agent has to drive crash recovery by hand',
  'packages/evals/src/index.ts': 'barrel for the evals package',
  'packages/evals/src/fixture-mailbox.ts':
    'per-case mailbox restriction, so one case cannot see another case fixtures',
  'packages/core/src/temporal-contract.ts':
    'the workflow argument and signal payload types, shared by the worker and the intake path without either importing the other',
  'apps/backend/src/temporal/activities/failures.ts':
    'the retryable/non-retryable classification the activities share; inlining it in each activity is how the classification drifts',
  'apps/backend/src/temporal/activities/runtime.ts':
    'the per-activity Supabase and tool wiring, kept out of the activity bodies so a workflow test can substitute it',
  'packages/agent-kit/test/helpers/fake-supabase.ts':
    'an in-memory RPC recorder, so the recorder tests assert the calls the runtime makes rather than needing a database',
  'packages/core/test/helpers/lineage.ts':
    'builds a committed, approved, active agent version, which nine db tests need before they can begin',
  'packages/core/test/helpers/review.ts':
    'builds a finalized review session with comments, which the comment and freeze tests need before they can begin',
  'packages/ops/src/gates.ts':
    'the four verifications that need a credential this repository cannot contain, reported by name every time rather than left for a reader to infer from an all-green summary. It never fails: an absent key is not a defect in the code, and a red `pnpm verify` on the machine the README is written for would train the reader to ignore it.',
  'scripts/gates.ts': 'the three-line alias for `pnpm gates`, like every other file in scripts/',
  'apps/web/test/service/error-map.test.ts':
    'the §12 status contract, pinned. Every route delegates its status code to one module, so a code the mapping does not recognise is answered as a server fault — telling a caller to retry a refusal that will never succeed. The exhaustive case reads the codes out of the migrations rather than out of a list, which is what makes it notice a raise that was added without a status.',
  'apps/web/test/service/helpers.ts':
    'the service-test counterpart of the db factories: signs users in and walks a board to frozen and active',
  'apps/backend/test/helpers/workflow-env.ts':
    'a time-skipping Temporal environment with recording activity stubs, which all six workflow tests start from',
  'apps/web/test/stubs/server-only.ts':
    "an empty module the service tests alias 'server-only' to; the real one throws outside a Next build, which would make every service module unimportable under Vitest",
  'apps/backend/test/model-schemas.test.ts':
    'pins the shape sent to the model against the schemas in @meridian/core. A schema name is not a contract: asked only for "invoice", the model answers accurately under names of its own choosing and the agent files a legible document as unreadable. No other test can catch a rename here, because the mock extractor answers in the agent shape by construction.',
  'packages/ops/test/preflight.test.ts':
    'the live-mode coherence check — the one preflight result that asserts a relationship between two settings rather than the presence of a tool. GMAIL_LIVE_MODE also sends documents down the live path, so pairing it with a mocked model is unsatisfiable in a way that only surfaces mid-run.',
  'packages/ops/test/connect-gmail.test.ts':
    'covers the consent flow being re-runnable: a second run must find the existing connection rather than throw, which is the difference between a setup step an operator can repeat and one that works exactly once.',
  // Named in §16 or §7.0 but absent from the §11 tree listing, which enumerates source exhaustively
  // and tests only representatively.
  'packages/core/test/db/delta-empty-arrays.test.ts': '§16: empty and NULL delta arrays',
  'packages/core/test/db/manual-review-intake.test.ts': '§7.0 RPC 23 named test',
  'packages/core/test/db/rpc-inventory.test.ts': '§7.0 machine-checkable expectation',
  'packages/core/test/db/rpc-rename-whiteboard.test.ts': '§7.0 RPC 2 named test',
  'apps/web/test/service/intake-no-key.test.ts': '§7.0 RPC 23: named explicitly',
  'apps/backend/test/workflow-boundary.test.ts':
    '§10: the workflow sandbox rejects a direct Supabase import',
};

/** Top-level entries that are build output, tooling state, or version control. */
const IGNORED_TOP_LEVEL = new Set([
  '.git',
  '.github',
  '.meridian',
  '.next',
  '.vscode',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

export interface TreeReport {
  missing: string[];
  undeclaredExtras: string[];
  migrationCount: number;
  evalCaseCount: number;
  ok: boolean;
}

/** Directories whose entire authored contents are covered by the manifest. */
const SCANNED_SOURCE_ROOTS = [
  'apps/web/src',
  'apps/web/test',
  'apps/web/e2e',
  'apps/backend/src',
  'apps/backend/test',
  'packages/core/src',
  'packages/core/test',
  'packages/agent-kit/src',
  'packages/agent-kit/test',
  'packages/evals/src',
  'packages/evals/test',
  'packages/ops/src',
  'packages/ops/test',
  'scripts',
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.css', '.mjs'];

function walkSources(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        found.push(relative(repoPath(), absolute));
      }
    }
  }
  return found.sort();
}

export function verifyTree(): TreeReport {
  const missing = REQUIRED_PATHS.filter((path) => !existsSync(repoPath(path)));

  const migrationsDir = repoPath('supabase/migrations');
  const migrationCount = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).length
    : 0;

  const caseDir = repoPath('examples/inbound-import-receiving/evals');
  const evalCaseCount = existsSync(caseDir)
    ? readdirSync(caseDir).filter((name) => /^case-\d{2}\.json$/.test(name)).length
    : 0;

  // `scripts/` must hold nothing but the three-line aliases: a test directory there would be
  // behaviour living outside the build graph, which is the thing A27 exists to prevent.
  const scriptsDir = repoPath('scripts');
  const scriptExtras = existsSync(scriptsDir)
    ? readdirSync(scriptsDir).filter((name) => !name.endsWith('.ts'))
    : [];

  const required = new Set(REQUIRED_PATHS);
  const declared = Object.keys(DECLARED_ADDITIONS);
  const sourceExtras = SCANNED_SOURCE_ROOTS.flatMap((root) => walkSources(repoPath(root))).filter(
    (path) => !required.has(path) && !declared.some((prefix) => path.startsWith(prefix)),
  );

  const topLevel = readdirSync(repoPath()).filter(
    (name) => !IGNORED_TOP_LEVEL.has(name) && !name.startsWith('.env'),
  );
  const allowedTopLevel = new Set([
    'apps',
    'packages',
    'generated-agents',
    'examples',
    'supabase',
    'scripts',
    'docs',
    '.codex',
    '.gitignore',
    '.prettierrc.json',
    '.prettierignore',
    'README.md',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'tsconfig.base.json',
    'tsconfig.json',
    'tsconfig.scripts.json',
    // The companion to `tsconfig.scripts.json`, for the same reason: no `.ts` file may sit outside
    // a project. Without it every test file falls outside the build graph, which costs the type
    // checker nothing at build time but silently disables type-aware linting across the whole test
    // suite — the rules that catch a floating promise or a misused `any` stop running exactly where
    // the assertions live.
    'tsconfig.tests.json',
    'eslint.config.mjs',
    'vitest.workspace.ts',
    '.nvmrc',
    '.pnpm-store',
    '.temporal',
  ]);
  // The approved PRD document is checked in under whatever name the reviewer gave it and must not
  // be renamed, so it is matched by extension rather than by an exact filename.
  const topExtras = topLevel.filter(
    (name) => !allowedTopLevel.has(name) && !name.endsWith('.docx'),
  );

  const undeclaredExtras = [
    ...sourceExtras,
    ...topExtras.map((name) => `<root>/${name}`),
    ...scriptExtras.map((name) => `scripts/${name}`),
  ].sort();

  return {
    missing,
    undeclaredExtras,
    migrationCount,
    evalCaseCount,
    ok:
      missing.length === 0 &&
      undeclaredExtras.length === 0 &&
      migrationCount === REQUIRED_MIGRATIONS &&
      evalCaseCount === REQUIRED_EVAL_CASES,
  };
}

export function formatTreeReport(report: TreeReport): string {
  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push('missing required paths:', ...report.missing.map((path) => `  - ${path}`));
  }
  if (report.undeclaredExtras.length > 0) {
    lines.push(
      'undeclared extra paths (add them to DECLARED_ADDITIONS with a reason, or remove them):',
      ...report.undeclaredExtras.map((path) => `  + ${path}`),
    );
  }
  if (report.migrationCount !== REQUIRED_MIGRATIONS) {
    lines.push(
      `expected ${String(REQUIRED_MIGRATIONS)} migrations, found ${String(report.migrationCount)}`,
    );
  }
  if (report.evalCaseCount !== REQUIRED_EVAL_CASES) {
    lines.push(
      `expected ${String(REQUIRED_EVAL_CASES)} eval cases, found ${String(report.evalCaseCount)}`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      `tree ok: ${String(REQUIRED_PATHS.length)} required paths, ${String(report.migrationCount)} migrations, ${String(report.evalCaseCount)} eval cases`,
    );
  }
  return lines.join('\n');
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const report = verifyTree();
  process.stdout.write(`${formatTreeReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
