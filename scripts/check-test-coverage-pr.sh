#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# TDAD Gate: Enforce test-first development on PRs
#
# For every changed source file in backend/src/services/ or backend/src/routers/,
# verify that a corresponding test file was also modified in the same PR.
#
# Escape hatch: include [skip-tdad] in any commit message to bypass.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE_BRANCH="${TDAD_BASE_BRANCH:-origin/main}"

# ── Escape hatch ────────────────────────────────────────────────────────────
if git log "${BASE_BRANCH}...HEAD" --pretty=format:"%s" 2>/dev/null | grep -q '\[skip-tdad\]'; then
  echo "TDAD check skipped via [skip-tdad] commit message"
  exit 0
fi

# ── Gather changed source files ────────────────────────────────────────────
CHANGED_SRC=$(git diff --name-only "${BASE_BRANCH}...HEAD" -- \
  'backend/src/services/*.ts' \
  'backend/src/routers/*.ts' 2>/dev/null || true)

if [ -z "$CHANGED_SRC" ]; then
  echo "TDAD: No service or router source files changed — nothing to check."
  exit 0
fi

# ── Gather all changed files (for test lookup) ─────────────────────────────
ALL_CHANGED=$(git diff --name-only "${BASE_BRANCH}...HEAD" 2>/dev/null || true)

MISSING=()

for SRC_FILE in $CHANGED_SRC; do
  BASENAME=$(basename "$SRC_FILE" .ts)

  # Compute kebab-case variant: FooService -> foo-service, batchQuest -> batch-quest
  KEBAB=$(echo "$BASENAME" | sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' | tr '[:upper:]' '[:lower:]')

  # Determine if this is a service or router
  if echo "$SRC_FILE" | grep -q '/services/'; then
    KIND="service"
  else
    KIND="router"
  fi

  # Build list of acceptable test file patterns
  PATTERNS=()

  if [ "$KIND" = "service" ]; then
    PATTERNS+=(
      "backend/tests/unit/${BASENAME}.test.ts"
      "backend/tests/unit/${KEBAB}.test.ts"
      "backend/tests/unit/${KEBAB}-service.test.ts"
      "backend/tests/unit/${BASENAME}-service.test.ts"
      "backend/tests/integration/${BASENAME}.test.ts"
      "backend/tests/integration/${KEBAB}.test.ts"
    )
  else
    PATTERNS+=(
      "backend/tests/unit/${BASENAME}-router.test.ts"
      "backend/tests/unit/${KEBAB}-router.test.ts"
      "backend/tests/unit/${BASENAME}.test.ts"
      "backend/tests/unit/${KEBAB}.test.ts"
      "backend/tests/integration/routers/${BASENAME}.test.ts"
      "backend/tests/integration/routers/${KEBAB}.test.ts"
      "backend/tests/integration/routers/${BASENAME}-router.test.ts"
      "backend/tests/integration/routers/${KEBAB}-router.test.ts"
    )
  fi

  # Check if any matching test file was changed
  FOUND=false
  for PATTERN in "${PATTERNS[@]}"; do
    if echo "$ALL_CHANGED" | grep -qF "$PATTERN"; then
      FOUND=true
      break
    fi
  done

  if [ "$FOUND" = false ]; then
    MISSING+=("$SRC_FILE")
  fi
done

# ── Report ──────────────────────────────────────────────────────────────────
if [ ${#MISSING[@]} -eq 0 ]; then
  echo "TDAD: All changed source files have accompanying test changes."
  exit 0
fi

echo ""
echo "============================================================"
echo "  TDAD GATE FAILED: Missing test changes"
echo "============================================================"
echo ""
echo "The following source files were changed without corresponding"
echo "test file changes:"
echo ""
for FILE in "${MISSING[@]}"; do
  echo "  - $FILE"
done
echo ""
echo "For each changed source file, update or create a test file in"
echo "backend/tests/unit/ or backend/tests/integration/."
echo ""
echo "Run 'npm run generate:test-stubs' to auto-generate skeletons."
echo ""
echo "To bypass this check, add [skip-tdad] to a commit message."
echo "============================================================"
exit 1
