#!/usr/bin/env bash
# task-quality-gate.sh
# Hook: TaskCompleted — blocks task completion without verification
#
# Exit 0 = allow completion
# Exit 2 = block completion
#
# Runs incremental tsc + vitest on changed files only (~15s total).
# Full suite validation happens in CI (ci.yml), not here.

set -euo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Run incremental type check
if ! (cd "$CWD" && npx tsc --noEmit --incremental 2>&1); then
  echo '{"decision": "block", "reason": "TypeScript type check failed. Fix type errors before marking task complete."}'
  exit 2
fi

# Run tests for changed files — capture exit code directly (no || true)
VITEST_EXIT=0
TEST_OUTPUT=$(cd "$CWD" && npx vitest run --changed --bail 1 --reporter=dot 2>&1) || VITEST_EXIT=$?

if [ "$VITEST_EXIT" -ne 0 ]; then
  # Allow only "no test files found" (vitest exits non-zero for that too)
  if echo "$TEST_OUTPUT" | grep -qiE 'no test (files|suites) found'; then
    exit 0
  fi
  echo '{"decision": "block", "reason": "Tests for changed files are failing. Fix failing tests before marking task complete."}'
  exit 2
fi

exit 0
