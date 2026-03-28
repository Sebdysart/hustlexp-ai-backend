#!/usr/bin/env bash
# task-quality-gate.sh
# Hook: TaskCompleted — blocks task completion without verification
#
# Exit 0 = allow completion
# Exit 2 = block completion
#
# AUDIT FIX (P3): Previous version ran the full test suite (6315 tests,
# fileParallelism: false, ~2+ minutes). Now runs:
#   1. tsc --noEmit --incremental (~5s with warm cache)
#   2. vitest --changed --bail 1 (~10s for changed files only)
# Full suite validation happens in CI (ci.yml), not in the task gate.

set -euo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Run incremental type check
if ! (cd "$CWD" && npx tsc --noEmit --incremental 2>&1); then
  echo '{"decision": "block", "reason": "TypeScript type check failed. Fix type errors before marking task complete."}'
  exit 2
fi

# Run tests for changed files only
TEST_OUTPUT=$(cd "$CWD" && npx vitest run --changed --bail 1 --reporter=dot 2>&1) || true

# Check if tests passed or if there were no tests to run
if echo "$TEST_OUTPUT" | grep -qiE '(fail|error.*test)'; then
  if ! echo "$TEST_OUTPUT" | grep -qiE '(no test (files|suites) found)'; then
    echo '{"decision": "block", "reason": "Tests for changed files are failing. Fix failing tests before marking task complete."}'
    exit 2
  fi
fi

exit 0
