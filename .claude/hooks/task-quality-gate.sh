#!/usr/bin/env bash
# task-quality-gate.sh
# Hook: TaskCompleted — blocks task completion without verification
#
# Exit 0 = allow completion
# Exit 2 = block completion

set -euo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Run tests
if ! cd "$CWD" && npx vitest run --reporter=dot 2>&1 | tail -5 | grep -q "pass"; then
  echo '{"decision": "block", "reason": "Tests are not passing. Fix failing tests before marking task complete."}'
  exit 2
fi

exit 0
