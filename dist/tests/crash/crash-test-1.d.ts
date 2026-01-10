#!/usr/bin/env npx tsx
/**
 * CRASH CONSISTENCY TEST #1: "Stripe Succeeds, Node Dies"
 *
 * Category 1, Item 1: Money Cannot Be Lost
 *
 * PASS CONDITIONS (ALL MUST BE TRUE):
 * - Exactly 1 committed ledger transaction
 * - Exactly 1 Stripe transfer
 * - Zero-sum invariant holds
 * - money_events_processed contains exactly 1 event
 * - No manual DB edits required
 *
 * FAIL CONDITIONS (ANY = FAIL):
 * - Duplicate ledger entries
 * - Missing ledger entry
 * - Ledger != Stripe
 * - Requires manual repair
 */
export {};
//# sourceMappingURL=crash-test-1.d.ts.map