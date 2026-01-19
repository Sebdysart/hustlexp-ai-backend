/**
 * PAYOUT COMPLETION HANDLER
 *
 * Orchestrates post-payout actions:
 * 1. Award XP (via AtomicXPService)
 * 2. Check trust tier upgrade (via TrustTierService)
 * 3. Update badge progress (via badge_ledger)
 *
 * Called after StripeMoneyEngine successfully releases a payout.
 *
 * INVARIANTS:
 * - INV-XP-2: XP only awarded after RELEASED state
 * - INV-5: XP idempotent per escrow
 * - INV-TRUST-1: Trust upgrade checked after each completion
 */
import { XPAwardResult } from './AtomicXPService.js';
export interface PayoutCompletionResult {
    taskId: string;
    hustlerId: string;
    xp: XPAwardResult;
    trustUpgraded: boolean;
    oldTrustTier: number;
    newTrustTier: number;
    badgesAwarded: string[];
    success: boolean;
    errors: string[];
}
/**
 * Handle all post-payout completion tasks
 *
 * This function should be called AFTER StripeMoneyEngine.handle()
 * successfully completes a RELEASE_PAYOUT event.
 *
 * It is IDEMPOTENT - safe to call multiple times for the same task.
 */
export declare function handlePayoutCompletion(taskId: string, hustlerId: string): Promise<PayoutCompletionResult>;
/**
 * Verify that a task has had XP awarded
 * Used for debugging/auditing
 */
export declare function verifyXPAwarded(taskId: string): Promise<{
    awarded: boolean;
    xpLedgerEntry: any | null;
}>;
//# sourceMappingURL=PayoutCompletionHandler.d.ts.map