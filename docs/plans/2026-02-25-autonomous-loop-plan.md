# Autonomous Development Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up a fully autonomous issue-to-merge development loop using Claude Code Action, MCP servers (GitHub, Greptile, Linear), hooks, and the existing Zenith Codex quality pipeline.

**Architecture:** Claude Code Action triggers on issue labels and PR review comments in GitHub Actions. Three MCP servers give it hands (GitHub for PR ops, Greptile for codebase intelligence, Linear for ticket management). Hooks enforce TDD and verification discipline. The existing orchestrator pipeline remains the quality gate, with a new auto-merge job for autonomous branches.

**Tech Stack:** Claude Code Action (`anthropics/claude-code-action@v1`), MCP (HTTP transport), GitHub Actions, existing Zenith Codex pipeline (TypeScript scripts), shell hooks.

**Design doc:** `docs/plans/2026-02-25-autonomous-loop-design.md`

---

### Task 1: Create `.mcp.json` — MCP Server Configuration

**Files:**
- Create: `.mcp.json`

**Step 1: Create the MCP configuration file**

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "greptile": {
      "type": "http",
      "url": "https://api.greptile.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GREPTILE_API_KEY}"
      }
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

Write this to `.mcp.json` at project root.

**Step 2: Verify MCP servers load locally**

Run Claude Code in the project directory and use `/mcp` to check that all three servers are listed and reachable. GitHub and Linear will require OAuth authentication on first use — complete the browser flow.

**Step 3: Commit**

```bash
git add .mcp.json
git commit -m "feat: add MCP server config (GitHub, Greptile, Linear)"
```

---

### Task 2: Create `CLAUDE.md` — Autonomous Protocol Instructions

**Files:**
- Create: `CLAUDE.md`

**Step 1: Write the CLAUDE.md file**

This file encodes superpowers-equivalent discipline for headless CI execution where plugins don't load. It also serves as project-level instructions for interactive sessions.

```markdown
# HustleXP AI Backend — Claude Code Instructions

## Project Overview

Node.js backend: Hono + tRPC + BullMQ + PostgreSQL. 690+ tests across 32 files.

## Key Commands

- **Tests:** `npx vitest run`
- **Type check:** `npx tsc --noEmit`
- **Lint:** `npx eslint .`
- **Single test file:** `npx vitest run backend/tests/<file>.test.ts`

## Autonomous Implementation Protocol

When implementing from an issue or fixing review comments:

1. **Context first** — Query Greptile MCP (`search_custom_context`) for relevant codebase patterns before writing code
2. **Tests first (TDD)** — Write a failing test, run it to verify it fails, then implement
3. **Verify before pushing** — Run the full test suite (`npx vitest run`), type check (`npx tsc --noEmit`), and lint (`npx eslint .`). All must pass.
4. **After pushing** — Check for Greptile review comments using Greptile MCP (`get_unaddressed_comments`). Fix all comments, push again.
5. **Repeat** — Continue the fix-push-review loop until no unaddressed comments remain
6. **Update tickets** — If a Linear ticket is linked, update its status via Linear MCP

## Quality Invariants (MUST NOT VIOLATE)

### Financial Invariants (Enforced by PostgreSQL triggers)
- **INV-1:** Escrow amounts must be positive integers in cents (`escrow_balance_check`)
- **INV-2:** XP requires released escrow (`xp_requires_released_escrow`)
- **INV-3:** Escrow can only be released once (`prevent_double_release`)
- **INV-4:** Ledger entries are immutable — no UPDATE/DELETE (`ledger_entry_immutable`)
- **INV-5:** Payment amounts must be positive (`payment_amount_check`)

### State Machines
- Task: `open` → `assigned` → `in_progress` → `completed` / `cancelled`
- Escrow: `PENDING` → `FUNDED` → `RELEASED` / `REFUNDED` / `DISPUTED`
- Always go through TaskService or EscrowService — never transition states directly

### Architecture Rules
- External API calls must be wrapped in CircuitBreaker (`backend/src/middleware/circuit-breaker.ts`)
- AI calls go through AIRouter with budget enforcement — never call providers directly
- Database queries use parameterized queries — no string interpolation
- All tRPC procedures need Zod input validation
- Admin endpoints use `adminProcedure` (not `protectedProcedure`)
- Stripe webhooks must verify signatures before processing

## Branch Naming

- Autonomous branches: `auto/{issue-number}` (eligible for auto-merge)
- Human branches: any other pattern (require manual merge)
```

Write this to `CLAUDE.md` at project root.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: add CLAUDE.md with autonomous protocol and quality invariants"
```

---

### Task 3: Create Hook Scripts

**Files:**
- Create: `.claude/hooks/verify-before-stop.sh`
- Create: `.claude/hooks/task-quality-gate.sh`

**Step 1: Create the hooks directory**

```bash
mkdir -p .claude/hooks
```

**Step 2: Write `verify-before-stop.sh`**

This hook reads the Claude session transcript from stdin and checks if tests were run and passed before allowing Claude to stop.

```bash
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
```

**Step 3: Write `task-quality-gate.sh`**

```bash
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
```

**Step 4: Make scripts executable**

```bash
chmod +x .claude/hooks/verify-before-stop.sh
chmod +x .claude/hooks/task-quality-gate.sh
```

**Step 5: Commit**

```bash
git add .claude/hooks/
git commit -m "feat: add Claude Code hooks (stop gate + task quality gate)"
```

---

### Task 4: Create `.claude/settings.json` — Project-Level Hook Config

**Files:**
- Create: `.claude/settings.json`

**Step 1: Write the project settings file**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "If the Bash command contained 'git push', respond with: 'IMPORTANT: Code was just pushed. Check for Greptile review comments using the Greptile MCP get_unaddressed_comments tool. Fix any issues found and push again.' Otherwise respond with 'proceed'."
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/verify-before-stop.sh"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/task-quality-gate.sh"
          }
        ]
      }
    ]
  }
}
```

Write this to `.claude/settings.json`.

**Step 2: Verify hooks load**

Start a new Claude Code session in the project directory. Run `/hooks` to confirm all three hooks are registered.

**Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "feat: add project-level Claude Code hook configuration"
```

---

### Task 5: Create `claude-implement.yml` — Issue-to-PR Workflow

**Files:**
- Create: `.github/workflows/claude-implement.yml`

**Step 1: Write the workflow**

```yaml
name: Claude — Autonomous Implementation

on:
  issues:
    types: [opened, assigned, labeled]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  implement:
    name: Autonomous Implementation
    if: contains(github.event.issue.labels.*.name, 'auto')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            You are implementing issue #${{ github.event.issue.number }}: "${{ github.event.issue.title }}"

            Issue body:
            ${{ github.event.issue.body }}

            Follow the Autonomous Implementation Protocol in CLAUDE.md exactly:
            1. Query Greptile MCP for relevant codebase context
            2. Create branch auto/${{ github.event.issue.number }}
            3. Write failing tests FIRST (TDD)
            4. Implement until all tests pass
            5. Run full verification: npx vitest run && npx tsc --noEmit && npx eslint .
            6. Push branch and create a PR linking issue #${{ github.event.issue.number }}
            7. PR title should be descriptive of the change, not just the issue number

            Use the GitHub MCP tools to create the PR. Include "Closes #${{ github.event.issue.number }}" in the PR body.
          claude_args: '{"max_turns": 50}'
        env:
          GREPTILE_API_KEY: ${{ secrets.GREPTILE_API_KEY }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
```

Write this to `.github/workflows/claude-implement.yml`.

**Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/claude-implement.yml'))" && echo "Valid YAML"
```

Expected: `Valid YAML`

**Step 3: Commit**

```bash
git add .github/workflows/claude-implement.yml
git commit -m "feat: add Claude autonomous implementation workflow"
```

---

### Task 6: Create `claude-review-fix.yml` — Review Fix Loop Workflow

**Files:**
- Create: `.github/workflows/claude-review-fix.yml`

**Step 1: Write the workflow**

```yaml
name: Claude — Review Fix Loop

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  fix-review-comments:
    name: Fix Review Comments
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review' &&
       github.event.review.state == 'changes_requested' &&
       startsWith(github.event.pull_request.head.ref, 'auto/'))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          trigger_phrase: "@claude"
          claude_args: '{"max_turns": 30}'
        env:
          GREPTILE_API_KEY: ${{ secrets.GREPTILE_API_KEY }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
```

Write this to `.github/workflows/claude-review-fix.yml`.

**Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/claude-review-fix.yml'))" && echo "Valid YAML"
```

Expected: `Valid YAML`

**Step 3: Commit**

```bash
git add .github/workflows/claude-review-fix.yml
git commit -m "feat: add Claude review fix loop workflow"
```

---

### Task 7: Modify `orchestrator.yml` — Add Auto-Merge Gate

**Files:**
- Modify: `.github/workflows/orchestrator.yml` (append after line 325)

**Step 1: Read the current readiness-score job outputs**

The readiness-score job at line 275 currently doesn't expose outputs. We need to add outputs and the auto-merge job.

Add `outputs` to the readiness-score job and add the auto-merge job after line 325.

**Step 2: Add outputs to readiness-score job**

At line 275, modify the readiness-score job to add outputs:

```yaml
  readiness-score:
    name: Readiness Score
    runs-on: ubuntu-latest
    if: always()
    needs: [classify, context, tdad, ci, invariants, holodeck, migration-safety, greptile-review]
    outputs:
      score: ${{ steps.score.outputs.total_score }}
      meets_threshold: ${{ steps.score.outputs.meets_threshold }}
    steps:
```

The `compute-readiness-score.ts` script needs to output these values. Check if it already does — if not, add two lines at the end of the script:

```bash
echo "total_score=$SCORE" >> $GITHUB_OUTPUT
echo "meets_threshold=$MEETS" >> $GITHUB_OUTPUT
```

**Step 3: Add auto-merge job after line 325**

Append this to the end of `orchestrator.yml`:

```yaml

  # ─────────────────────────────────────────────────────────
  # Stage 7: Auto-Merge (only for autonomous branches)
  # ─────────────────────────────────────────────────────────
  auto-merge:
    name: Auto-Merge Gate
    runs-on: ubuntu-latest
    if: >-
      always() &&
      startsWith(github.event.pull_request.head.ref, 'auto/') &&
      needs.readiness-score.outputs.meets_threshold == 'true' &&
      needs.greptile-review.outputs.critical_count == '0' &&
      needs.ci.result == 'success'
    needs: [readiness-score, greptile-review, ci]
    steps:
      - name: Auto-merge autonomous PR
        run: |
          echo "Readiness score meets threshold, Greptile review clean, CI green."
          echo "Auto-merging autonomous PR #${{ github.event.pull_request.number }}..."
          gh pr merge ${{ github.event.pull_request.number }} --squash --auto \
            --subject "auto: $(gh pr view ${{ github.event.pull_request.number }} --json title -q .title)"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Step 4: Verify the full orchestrator YAML is still valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/orchestrator.yml'))" && echo "Valid YAML"
```

Expected: `Valid YAML`

**Step 5: Commit**

```bash
git add .github/workflows/orchestrator.yml
git commit -m "feat: add auto-merge gate for autonomous branches in orchestrator"
```

---

### Task 8: Check readiness score script outputs

**Files:**
- Modify: `scripts/compute-readiness-score.ts` (if needed)

**Step 1: Check if the script already writes to GITHUB_OUTPUT**

Search `compute-readiness-score.ts` for `GITHUB_OUTPUT`. If it already outputs `total_score` and `meets_threshold`, this task is done.

**Step 2: If not, add GITHUB_OUTPUT writes**

Find where the script computes the final score and determines pass/fail. Add:

```typescript
// Write outputs for GitHub Actions
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  const fs = await import('fs');
  fs.appendFileSync(outputFile, `total_score=${totalScore}\n`);
  fs.appendFileSync(outputFile, `meets_threshold=${meetsThreshold}\n`);
}
```

**Step 3: Run existing tests to verify no regression**

```bash
npx vitest run backend/tests/ --reporter=dot
```

Expected: All 690+ tests pass.

**Step 4: Commit (if changes were made)**

```bash
git add scripts/compute-readiness-score.ts
git commit -m "feat: expose readiness score outputs for auto-merge gate"
```

---

### Task 9: Add GitHub Secrets

**Files:** None (GitHub UI / CLI only)

**Step 1: Add ANTHROPIC_API_KEY secret**

```bash
gh secret set ANTHROPIC_API_KEY --repo Sebdysart/hustlexp-ai-backend
```

Paste your Anthropic API key when prompted.

**Step 2: Add LINEAR_API_KEY secret**

```bash
gh secret set LINEAR_API_KEY --repo Sebdysart/hustlexp-ai-backend
```

Paste your Linear API key when prompted.

**Step 3: Verify all secrets exist**

```bash
gh secret list --repo Sebdysart/hustlexp-ai-backend
```

Expected output should include: `ANTHROPIC_API_KEY`, `GREPTILE_API_KEY`, `LINEAR_API_KEY`, plus any existing secrets.

---

### Task 10: Install Claude GitHub App

**Files:** None

**Step 1: Install the Claude GitHub App**

```bash
claude /install-github-app
```

Or manually: go to https://github.com/apps/claude and install it on the `Sebdysart/hustlexp-ai-backend` repository.

**Step 2: Verify the app is installed**

```bash
gh api repos/Sebdysart/hustlexp-ai-backend/installation --jq '.id' 2>/dev/null || echo "Check GitHub Settings > Integrations"
```

---

### Task 11: End-to-End Smoke Test

**Files:** None (testing only)

**Step 1: Push all commits to a test branch**

```bash
git checkout -b feat/autonomous-loop
git push -u origin feat/autonomous-loop
```

**Step 2: Create a test issue with the `auto` label**

```bash
gh issue create \
  --repo Sebdysart/hustlexp-ai-backend \
  --title "Test: Add a health check endpoint that returns server uptime" \
  --body "Add a GET /health endpoint that returns JSON with: status, uptime in seconds, and current timestamp. This is a smoke test for the autonomous implementation loop." \
  --label "auto"
```

**Step 3: Monitor the GitHub Action**

```bash
gh run watch --repo Sebdysart/hustlexp-ai-backend
```

Expected: `claude-implement.yml` triggers, Claude creates a branch, implements the feature with tests, and opens a PR.

**Step 4: Verify the orchestrator fires on the new PR**

Check that `orchestrator.yml` runs on the PR and computes a readiness score.

**Step 5: Test the review-fix loop**

Post a review comment on the PR:

```bash
gh pr comment <PR_NUMBER> --body "@claude Please also add the Node.js version to the health check response"
```

Expected: `claude-review-fix.yml` triggers, Claude reads the comment, applies the change, pushes.

**Step 6: Clean up test issue if needed**

```bash
gh issue close <ISSUE_NUMBER> --repo Sebdysart/hustlexp-ai-backend
```

---

### Task 12: Push to Main Branch

**Files:** None

**Step 1: Create PR for the autonomous loop setup**

```bash
gh pr create \
  --title "feat: autonomous development loop (Claude Code + MCP + Zenith Codex)" \
  --body "## Summary
- Adds 3 MCP servers (GitHub, Greptile, Linear) via .mcp.json
- Adds CLAUDE.md with autonomous implementation protocol
- Adds Claude Code hooks (stop gate, task quality gate, post-push review check)
- Adds claude-implement.yml workflow (issue → branch → implement → PR)
- Adds claude-review-fix.yml workflow (review comment → fix → push loop)
- Adds auto-merge gate to orchestrator.yml for auto/* branches

## Design Doc
See docs/plans/2026-02-25-autonomous-loop-design.md

## Test Plan
- [ ] MCP servers load locally (run /mcp in Claude Code)
- [ ] Hooks register (run /hooks in Claude Code)
- [ ] claude-implement.yml triggers on 'auto' labeled issue
- [ ] claude-review-fix.yml triggers on @claude PR comment
- [ ] Auto-merge gate only activates for auto/* branches
- [ ] Existing orchestrator pipeline unaffected for human branches"
```

**Step 2: Merge after orchestrator passes**

Wait for the Zenith Codex orchestrator to run on this PR. Merge manually (this is a human branch, not auto/*).

---

Plan complete and saved to `docs/plans/2026-02-25-autonomous-loop-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
