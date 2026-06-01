#!/usr/bin/env bash
# verify-before-stop.sh
# Hook: Stop — blocks Claude from finishing if code changes aren't verified
#
# Exit 0 = allow stop
# Exit 2 = block stop (return JSON with reason on stdout)
#
# Checks for TS changes at three levels:
#   1. Uncommitted (staged + unstaged)
#   2. Untracked new .ts files
#   3. Committed-on-branch (vs origin/main) — catches code committed without verification

set -euo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Non-implementation tasks can stop freely
if echo "$LAST_MSG" | grep -qiE '(no (code )?changes|read-only|no modifications|just (a )?question)'; then
  exit 0
fi

# Detect TS changes at all three levels
HAS_UNCOMMITTED=$(cd "$CWD" && git diff --name-only HEAD 2>/dev/null | grep -c '\.ts$' || true)
HAS_STAGED=$(cd "$CWD" && git diff --cached --name-only 2>/dev/null | grep -c '\.ts$' || true)
HAS_UNTRACKED=$(cd "$CWD" && git ls-files --others --exclude-standard 2>/dev/null | grep -c '\.ts$' || true)
HAS_BRANCH=$(cd "$CWD" && git diff --name-only origin/main...HEAD 2>/dev/null | grep -c '\.ts$' || true)

# If no TS changes anywhere, allow stop
if [ "$HAS_UNCOMMITTED" -eq 0 ] && [ "$HAS_STAGED" -eq 0 ] && [ "$HAS_UNTRACKED" -eq 0 ] && [ "$HAS_BRANCH" -eq 0 ]; then
  exit 0
fi

# Run incremental type check
if ! (cd "$CWD" && npx tsc --noEmit --incremental 2>&1); then
  echo '{"decision": "block", "reason": "TypeScript type check failed. Run: npx tsc --noEmit --incremental — fix all type errors before finishing."}'
  exit 2
fi

# Run tests for changed files
VITEST_EXIT=0
TEST_OUTPUT=$(cd "$CWD" && npx vitest run --changed --bail 1 2>&1) || VITEST_EXIT=$?

if [ "$VITEST_EXIT" -ne 0 ]; then
  if echo "$TEST_OUTPUT" | grep -qiE 'no test (files|suites) found'; then
    exit 0
  fi
  echo '{"decision": "block", "reason": "Tests for changed files are failing. Run: npx vitest run --changed — fix failing tests before finishing."}'
  exit 2
fi

exit 0
