# HustleXP AI Backend — Claude Code Instructions

For Cursor/IDE instructions, see [AGENTS.md](AGENTS.md).

## Project Overview

Node.js backend: Hono + tRPC + BullMQ + PostgreSQL. 6,315 tests across 285 files (89.6% stmt, 77.6% branch coverage).

## Key Commands

- **Tests:** `npx vitest run` (uses vitest.workspace.ts — unit tests parallel, integration/system sequential)
- **Tests (changed only):** `npx vitest run --changed --bail 1`
- **Type check:** `npx tsc --noEmit` (incremental, ~5s warm cache)
- **Type check all projects:** `npx tsc -b` (src + tests + scripts via project references)
- **Lint:** `npx eslint .`
- **Single test file:** `npx vitest run backend/tests/<file>.test.ts`

## Autonomous Implementation Protocol

When implementing from an issue or fixing review comments:

1. **Context first** — Query Greptile MCP (`search_custom_context`) for relevant codebase patterns before writing code
2. **Tests first (TDD)** — Write a failing test, run it to verify it fails, then implement
3. **Verify before pushing** — Run incremental checks: `npx tsc --noEmit` + `npx vitest run --changed --bail 1`. All must pass.
4. **Full suite on push** — CI runs the complete test suite, typecheck, lint, and security audit on every push to `auto/*` and `feat/*` branches.
5. **After pushing** — Check for Greptile review comments using Greptile MCP (`get_unaddressed_comments`). Fix all comments, push again.
6. **Repeat** — Continue the fix-push-review loop until no unaddressed comments remain
7. **Update tickets** — If a Linear ticket is linked, update its status via Linear MCP

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

- Autonomous branches: `auto/{issue-number}` (eligible for auto-merge via `.github/workflows/auto-merge.yml`)
- Human branches: any other pattern (require manual merge)

## Project Structure

```
tsconfig.json          ← solution root with references
tsconfig.src.json      ← backend/src/**/* (strict, composite)
tsconfig.tests.json    ← backend/tests/**/* (relaxed, references src)
tsconfig.scripts.json  ← backend/scripts/**/* + backend/database/**/*.ts
vitest.workspace.ts    ← unit (parallel) + integration (sequential) + system (sequential)
```
