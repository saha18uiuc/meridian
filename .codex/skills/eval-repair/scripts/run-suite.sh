#!/usr/bin/env bash
# Run the complete eval suite for one agent version and report what the exit code means.
#
# The whole suite, never a subset. A repair that fixes the case in front of you and breaks a case
# you were not looking at is not a repair, and only the full run can tell you which one you made.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."

AGENT_VERSION="${1:-}"
if [[ -z "${AGENT_VERSION}" ]]; then
  echo "usage: $(basename "$0") <agentVersionId>" >&2
  exit 2
fi

pnpm evals --agent-version "${AGENT_VERSION}"
status=$?

case "${status}" in
  0)
    printf '\n\033[32mSuite green.\033[0m Nothing to repair.\n'
    ;;
  5)
    # `pnpm evals` has already written the review session and the blocking board comment.
    printf '\n\033[33mPolicy gap.\033[0m The frozen specification does not decide this case.\n'
    printf 'A blocking comment is on the board. Do NOT patch code. Report which decision is\n'
    printf 'undefined and which spec node you checked, and hand back to the operator.\n'
    ;;
  *)
    printf '\n\033[31mSuite failed (exit %s).\033[0m Classify each failure before patching:\n' "${status}"
    printf '  extraction / implementation  → reserve a repair version and fix it\n'
    printf '  tool_infrastructure          → fix the environment, not the agent\n'
    printf '  policy_gap                   → stop\n'
    printf 'See .codex/skills/eval-repair/references/failure-types.md\n'
    ;;
esac

exit "${status}"
