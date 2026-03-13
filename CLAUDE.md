# HustleXP AI Backend — Claude Code Instructions

For Cursor/IDE instructions, see [AGENTS.md](AGENTS.md).

## Project Overview

Node.js backend: Hono + tRPC + BullMQ + PostgreSQL. 5,448 tests across 239 files (89.6% stmt, 77.6% branch coverage).

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
