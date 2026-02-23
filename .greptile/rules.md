# HustleXP Constitutional Review Rules

## Financial Invariants (BLOCKING)

These invariants are enforced by PostgreSQL triggers. Any PR that modifies, disables, or circumvents these triggers MUST be flagged as a critical issue:

1. **INV-1: Escrow Balance Integrity** — `escrow_balance_check` trigger ensures escrow amounts are always positive integers in cents.
2. **INV-2: XP Requires Released Escrow** — `xp_requires_released_escrow` trigger prevents XP awards unless the task's escrow is in RELEASED state.
3. **INV-3: Double-Spend Prevention** — `prevent_double_release` trigger ensures an escrow can only be released once.
4. **INV-4: Ledger Immutability** — `ledger_entry_immutable` trigger prevents UPDATE/DELETE on ledger_entries.
5. **INV-5: Payment Amount Validation** — `payment_amount_check` trigger rejects zero or negative payment amounts.

## State Machine Rules

- Task states: `open` → `assigned` → `in_progress` → `completed` / `cancelled`
- Escrow states: `PENDING` → `FUNDED` → `RELEASED` / `REFUNDED` / `DISPUTED`
- Flag any code that transitions states without going through TaskService or EscrowService state machine methods.

## Security Rules

- All admin endpoints must use `adminProcedure` (not `protectedProcedure`)
- Never log passwords, tokens, API keys, or full credit card numbers
- Stripe webhook handlers must verify signatures before processing
- Rate limiting must be applied to all public-facing endpoints

## Architecture Rules

- External API calls must be wrapped in a CircuitBreaker from `backend/src/middleware/circuit-breaker.ts`
- AI calls must go through AIRouter with budget enforcement — never call providers directly
- Database queries in services must use parameterized queries (no string interpolation)
- All new tRPC procedures must have corresponding Zod input validation schemas
