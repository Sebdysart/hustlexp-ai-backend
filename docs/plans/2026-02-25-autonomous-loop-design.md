# Autonomous Development Loop — Design Document

**Date:** 2026-02-25
**Status:** Approved
**Approach:** Full Superpowers + MCP Loop (Approach 1)

## Overview

A fully autonomous development loop where Claude Code implements issues, responds to code reviews, and iterates until quality gates pass — all running in GitHub Actions with superpowers discipline and MCP-powered access to GitHub, Greptile, and Linear.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                            │
│                                                                 │
│  Linear (issue tagged 'auto')  ──┐                              │
│  GitHub (PR review comment)    ──┼──▶  GitHub Actions           │
│  GitHub (issue @claude)        ──┤     (claude-code-action)     │
│  Schedule (cron)               ──┘                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CLAUDE CODE (BRAIN)                         │
│                                                                 │
│  ┌─────────────────┐  ┌──────────────────────────────────────┐  │
│  │  Superpowers     │  │  MCP Servers                         │  │
│  │  Skills          │  │                                      │  │
│  │  ─────────────   │  │  ┌──────────┐ ┌────────┐ ┌───────┐  │  │
│  │  • TDD           │  │  │ GitHub   │ │Greptile│ │Linear │  │  │
│  │  • Debugging     │◀─┤  │ MCP      │ │MCP     │ │MCP    │  │  │
│  │  • Verification  │  │  │ (PR/code)│ │(review)│ │(tasks)│  │  │
│  │  • Brainstorming │  │  └──────────┘ └────────┘ └───────┘  │  │
│  │  • Code Review   │  │                                      │  │
│  └─────────────────┘  └──────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Hooks                                                    │   │
│  │  • PostToolUse(Bash/git push) → check Greptile review     │   │
│  │  • Stop → verify tests passed before finishing            │   │
│  │  • TaskCompleted → run quality gate                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    QUALITY GATE (EXISTING)                       │
│                                                                 │
│  Zenith Codex Orchestrator                                      │
│  ├── classify-pr-changes.ts (tier 0-3)                          │
│  ├── compute-readiness-score.ts (110-point)                     │
│  ├── greptile-pr-review.ts (auto-review)                        │
│  ├── analyze-migration-safety.ts                                │
│  └── evaluate-degradation.ts (three-tier mesh)                  │
│                                                                 │
│  Auto-merge gate: readiness ≥ 95 + Greptile clean + CI green   │
└─────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. MCP Servers (`.mcp.json`)

Three remote HTTP MCP servers configured at project level:

**GitHub MCP** — PR/issue operations, branch creation, CI status
- URL: `https://api.githubcopilot.com/mcp/`
- Auth: OAuth (local) / `GITHUB_TOKEN` (CI)

**Greptile MCP** — Codebase intelligence, review comments, context search
- URL: `https://api.greptile.com/mcp`
- Auth: Bearer token via `GREPTILE_API_KEY`
- Key tools: `get_unaddressed_comments`, `get_pr_review`, `search_custom_context`

**Linear MCP** — Ticket lifecycle management
- URL: `https://mcp.linear.app/mcp`
- Auth: OAuth (local) / `LINEAR_API_KEY` (CI)

### 2. GitHub Actions Workflows

#### `claude-implement.yml` — Issue to PR

Triggers on issue creation/assignment with `auto` label. Claude Code headless:
1. Reads issue via context
2. Queries Greptile MCP for codebase context
3. Creates feature branch (`auto/{issue-number}`)
4. Writes failing tests first (TDD)
5. Implements until tests pass
6. Pushes and creates PR linking issue
7. Updates Linear ticket if linked

Max turns: 50.

#### `claude-review-fix.yml` — Review Fix Loop

Triggers on PR review comments containing `@claude` or from `greptile[bot]`. Claude Code:
1. Reads the review comment
2. Queries Greptile MCP for unaddressed comments
3. Applies fixes
4. Pushes new commit
5. Loop handled by orchestrator re-triggering

Max turns: 30.

#### `orchestrator.yml` modification — Auto-merge Gate

New final job added to existing orchestrator:
- Only runs on `auto/*` branches
- Requires: readiness score ≥ 95 AND Greptile clean AND degradation passed
- Action: `gh pr merge --squash --auto`
- Human branches are unaffected

### 3. Hooks (`.claude/settings.json`)

**PostToolUse (Bash)** — Prompt hook that detects `git push` commands and reminds Claude to check for Greptile review comments via MCP.

**Stop** — Command hook running `verify-before-stop.sh`. Blocks Claude from finishing if tests haven't been verified as passing.

**TaskCompleted** — Command hook running `task-quality-gate.sh`. Blocks task completion without green tests and clean lint.

### 4. CLAUDE.md — Headless Protocol

Encodes superpowers-equivalent behaviors for CI (where plugins don't load):
- TDD protocol (test first)
- Verification protocol (tests + lint + types before claiming done)
- Greptile review response protocol (fix all comments, push, repeat)
- Quality invariants from `.greptile/rules.md`

## The Closed Loop

```
Linear issue (label: auto)
    │
    ▼
claude-implement.yml ──▶ Claude Code creates branch, TDD implements, pushes PR
    │
    ▼
orchestrator.yml ──▶ Zenith Codex classifies, scores, Greptile reviews
    │
    ▼
claude-review-fix.yml ──▶ Claude reads Greptile comments via MCP, fixes, pushes
    │
    ▼
orchestrator.yml re-runs ──▶ score ≥ 95 + clean + green?
    │                              │
    │ no                           │ yes
    ▼                              ▼
(loop back to fix)          auto-merge + Linear updated
```

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `.mcp.json` | Create | 3 MCP servers (GitHub, Greptile, Linear) |
| `.github/workflows/claude-implement.yml` | Create | Issue → branch → implement → PR |
| `.github/workflows/claude-review-fix.yml` | Create | Review comment → fix → push loop |
| `.github/workflows/orchestrator.yml` | Modify | Add auto-merge job for `auto/*` branches |
| `.claude/settings.json` | Create | Project-level hooks |
| `.claude/hooks/verify-before-stop.sh` | Create | Block stop if tests not verified |
| `.claude/hooks/task-quality-gate.sh` | Create | Block task completion without green tests |
| `CLAUDE.md` | Create | Autonomous implementation protocol |

## Secrets Required

| Secret | Status | Purpose |
|--------|--------|---------|
| `ANTHROPIC_API_KEY` | New | Claude Code Action |
| `GREPTILE_API_KEY` | Exists | Greptile MCP |
| `LINEAR_API_KEY` | New | Linear MCP in CI |
| `GITHUB_TOKEN` | Exists (auto) | GitHub Actions built-in |

## What Stays Untouched

- All 6 existing workflows
- All 690 tests
- Greptile config (`.greptile/rules.md`, `greptile.json`)
- Zenith Codex scripts
- iOS app

## Decisions Made

1. **Full autonomous loop** — not semi-autonomous or interactive-only
2. **Claude Code headless as sole agent** — no Sweep.dev or third-party AI
3. **GitHub Actions as runtime** — not local daemon
4. **GitHub + Greptile + Linear MCP** — the full trifecta
5. **Auto-merge only for `auto/*` branches** — human branches require manual merge
6. **Readiness threshold ≥ 95** — for auto-merge gate
