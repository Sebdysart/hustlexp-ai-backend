#!/usr/bin/env bash
# citadel-integrity-lock.sh
# Verifies the test vault has not been tampered with.
# Exit 0 = clean. Exit 1 = BREACH.
set -euo pipefail

echo "🛡️  Citadel: verifying test vault integrity..."

EXPECTED_SHA=$(git submodule status tests-vault | awk '{print $1}' | sed 's/^[-+]//')
ACTUAL_SHA=$(git -C tests-vault rev-parse HEAD)

if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
  echo "❌ CITADEL BREACH: tests-vault commit mismatch"
  echo "   Expected: $EXPECTED_SHA"
  echo "   Actual:   $ACTUAL_SHA"
  exit 1
fi

# Merkle: hash every file in vault and compare to recorded manifest
MANIFEST="tests-vault/.citadel-manifest.sha256"
if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ CITADEL BREACH: manifest file missing from vault"
  exit 1
fi

cd tests-vault
COMPUTED=$(find . -type f -not -name '.citadel-manifest.sha256' -not -name '.git' | sort | xargs sha256sum | sha256sum | awk '{print $1}')
RECORDED=$(cat .citadel-manifest.sha256)

if [[ "$COMPUTED" != "$RECORDED" ]]; then
  echo "❌ CITADEL BREACH: Merkle root mismatch — test files altered"
  echo "   Recorded: $RECORDED"
  echo "   Computed: $COMPUTED"
  exit 1
fi

echo "✅ Citadel: test vault integrity confirmed (SHA: ${ACTUAL_SHA:0:12})"
