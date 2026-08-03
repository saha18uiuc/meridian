#!/usr/bin/env bash
# Gate the generated agent before it is committed.
#
# Four checks, in increasing cost order, each stopping the run on failure. The smoke eval is last
# and deliberately runs one case rather than the suite: this script answers "is this code coherent
# enough to commit", not "is this agent correct". The full suite is `pnpm evals`, run after the
# commit exists, because a failing case is repaired against a recorded version rather than an
# uncommitted worktree.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."

SMOKE_CASE="${SMOKE_CASE:-case-01}"

step() {
  printf '\n\033[1m→ %s\033[0m\n' "$1"
}

step 'lint'
pnpm lint

step 'typecheck'
pnpm typecheck

step 'unit tests'
pnpm test:unit

step "smoke eval (${SMOKE_CASE})"
pnpm evals --only "${SMOKE_CASE}"

printf '\n\033[32mverify.sh passed\033[0m — run `pnpm agent:finalize --agent-version <id>` next.\n'
