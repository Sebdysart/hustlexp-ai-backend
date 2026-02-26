#!/usr/bin/env bash
# verify-before-stop.sh
# Hook: Stop — blocks Claude from finishing if tests weren't verified
#
# Reads JSON context on stdin with fields:
#   session_id, transcript_path, cwd, last_assistant_message
#
# Exit 0 = allow stop
# Exit 2 = block stop (return JSON with reason on stdout)

set -euo pipefail

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last message mentions test results passing
if echo "$LAST_MSG" | grep -qiE '(all tests pass|tests? (pass|passing|succeeded)|vitest.*pass|✓.*tests?)'; then
  exit 0
fi

# Check if this was a non-implementation task (e.g., just reading/answering questions)
if echo "$LAST_MSG" | grep -qiE '(no (code )?changes|read-only|no modifications|just (a )?question)'; then
  exit 0
fi

# Block — tests not verified
echo '{"decision": "block", "reason": "Tests not verified as passing. Run: npx vitest run && npx tsc --noEmit && npx eslint . — then confirm all pass before finishing."}'
exit 2
