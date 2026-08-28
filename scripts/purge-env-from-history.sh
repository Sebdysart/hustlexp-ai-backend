#!/bin/bash
# =============================================================================
# PURGE .env FROM GIT HISTORY
# =============================================================================
#
# WARNING: This script rewrites git history. All collaborators must re-clone.
#
# BEFORE RUNNING:
# 1. Rotate ALL credentials (see CREDENTIAL_ROTATION.md)
# 2. Ensure .gitignore includes .env
# 3. Back up the repository
#
# USAGE:
#   chmod +x scripts/purge-env-from-history.sh
#   ./scripts/purge-env-from-history.sh
#
# AFTER RUNNING:
#   git push --force --all
#   Notify all collaborators to re-clone
# =============================================================================

set -e

echo "============================================"
echo "  PURGING .env FROM GIT HISTORY"
echo "============================================"
echo ""

# Check for BFG first (recommended approach)
if command -v bfg &> /dev/null; then
    echo "Using BFG Repo Cleaner (recommended)..."
    echo ""
    bfg --delete-files .env
    git reflog expire --expire=now --all
    git gc --prune=now --aggressive
    echo ""
    echo "Done! Now run: git push --force --all"
else
    echo "BFG not found. Using git filter-branch (slower)..."
    echo ""
    echo "TIP: Install BFG for faster results:"
    echo "  brew install bfg"
    echo ""

    git filter-branch --force --index-filter \
        'git rm --cached --ignore-unmatch .env' \
        --prune-empty --tag-name-filter cat -- --all

    git reflog expire --expire=now --all
    git gc --prune=now --aggressive

    echo ""
    echo "Done! Now run: git push --force --all"
fi

echo ""
echo "============================================"
echo "  IMPORTANT: POST-PURGE STEPS"
echo "============================================"
echo ""
echo "1. Force push all branches: git push --force --all"
echo "2. Force push all tags: git push --force --tags"
echo "3. Tell ALL collaborators to re-clone the repository"
echo "4. Verify .env is no longer in history:"
echo "   git log --all --full-history -- .env"
echo "5. Double-check credentials were rotated"
echo ""
