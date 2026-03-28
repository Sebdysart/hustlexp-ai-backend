#!/usr/bin/env bash
# verify-before-stop.sh
# Hook: Stop — blocks Claude from finishing if code changes aren't verified
#
# Reads JSON context on stdin with fields:
#   session_id, transcript_path, cwd, last_assistant_message
#
# Exit 0 = allow stop
# Exit 2 = block stop (return JSON with reason on stdout)
#
# AUDIT FIX (P1): Previous version grepped the assistant's last message for
# phrases like "all tests pass" — a text-matching heuristic that could both
# false-positive and false-negative. Now runs real checks:
#   1. tsc --noEmit --incremental (~5s with warm cache)
#   2. vitest --changed --bail 1 (~10s for changed files only)
# Total: ~15s instead of ~3min for the full suite.

set -euo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if this was a non-implementation task (e.g., just reading/answering questions)
if echo "$LAST_MSG" | grep -qiE '(no (code )?changes|read-only|no modifications|just (a )?question)'; then
  exit 0
fi

# Check if there are any uncommitted changes to TypeScript files
HAS_CHANGES=$(cd "$CWD" && git diff --name-only HEAD 2>/dev/null | grep -c '\.ts$' || true)
HAS_STAGED=$(cd "$CWD" && git diff --cached --name-only 2>/dev/null | grep -c '\.ts$' || true)

# If no TS files changed, allow stop without running checks
if [ "$HAS_CHANGES" -eq 0 ] && [ "$HAS_STAGED" -eq 0 ]; then
  exit 0
fi

# Run incremental type check
if ! (cd "$CWD" && npx tsc --noEmit --incremental 2>&1); then
  echo '{"decision": "block", "reason": "TypeScript type check failed. Run: npx tsc --noEmit --incremental — fix all type errors before finishing."}'
  exit 2
fi

# Run tests for changed files only
if ! (cd "$CWD" && npx vitest run --changed --bail 1 2>&1 | tail -20 | grep -qiE '(pass|no test)'); then
  echo '{"decision": "block", "reason": "Tests for changed files are failing. Run: npx vitest run --changed — fix failing tests before finishing."}'
  exit 2
fi

exit 0
