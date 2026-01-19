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

import { awardXPForTask, XPAwardResult } from './AtomicXPService.js';
import { TrustTierService } from './TrustTierService.js';
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PayoutCompletionHandler');

// ============================================================================
// RESULT TYPE
// ============================================================================

export interface PayoutCompletionResult {
  taskId: string;
  hustlerId: string;
  
  // XP Result
  xp: XPAwardResult;
  
  // Trust Result
  trustUpgraded: boolean;
  oldTrustTier: number;
  newTrustTier: number;
  
  // Badge Result (placeholder for future)
  badgesAwarded: string[];
  
  // Summary
  success: boolean;
  errors: string[];
}

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Handle all post-payout completion tasks
 * 
 * This function should be called AFTER StripeMoneyEngine.handle() 
 * successfully completes a RELEASE_PAYOUT event.
 * 
 * It is IDEMPOTENT - safe to call multiple times for the same task.
 */
export async function handlePayoutCompletion(
  taskId: string,
  hustlerId: string
): Promise<PayoutCompletionResult> {
  const errors: string[] = [];
  
  logger.info({ taskId, hustlerId }, 'Starting payout completion handler');
  
  // 1. Award XP (idempotent via UNIQUE constraint)
  let xpResult: XPAwardResult;
  try {
    xpResult = await awardXPForTask(taskId, hustlerId);
    
    if (!xpResult.success && !xpResult.alreadyAwarded) {
      errors.push(`XP award failed: ${xpResult.error}`);
    }
    
    if (xpResult.leveledUp) {
      logger.info({
        taskId,
        hustlerId,
        oldLevel: xpResult.previousLevel,
        newLevel: xpResult.newLevel,
      }, 'User leveled up!');
    }
  } catch (error: any) {
    logger.error({ error, taskId, hustlerId }, 'XP award threw exception');
    errors.push(`XP award exception: ${error.message}`);
    xpResult = {
      success: false,
      xpAwarded: 0,
      baseXP: 0,
      decayFactor: '1.0000',
      effectiveXP: 0,
      streakMultiplier: '1.00',
      finalXP: 0,
      newTotalXP: 0,
      newLevel: 0,
      previousLevel: 0,
      leveledUp: false,
      newStreak: 0,
      alreadyAwarded: false,
      error: error.message,
    };
  }
  
  // 2. Check trust tier upgrade
  let trustUpgraded = false;
  let oldTrustTier = 1;
  let newTrustTier = 1;
  
  try {
    oldTrustTier = await TrustTierService.getTier(hustlerId);
    const upgradeResult = await TrustTierService.tryUpgrade(hustlerId);
    trustUpgraded = upgradeResult.upgraded;
    newTrustTier = upgradeResult.newTier;
    
    if (trustUpgraded) {
      logger.info({
        taskId,
        hustlerId,
        oldTier: oldTrustTier,
        newTier: newTrustTier,
      }, 'Trust tier upgraded!');
    }
  } catch (error: any) {
    logger.error({ error, taskId, hustlerId }, 'Trust tier check failed');
    errors.push(`Trust tier check failed: ${error.message}`);
  }
  
  // 3. Badge progress (placeholder - implement when badge system is ready)
  const badgesAwarded: string[] = [];
  // TODO: Check badge_ledger for badges that should be awarded
  
  const result: PayoutCompletionResult = {
    taskId,
    hustlerId,
    xp: xpResult,
    trustUpgraded,
    oldTrustTier,
    newTrustTier,
    badgesAwarded,
    success: errors.length === 0,
    errors,
  };
  
  logger.info({
    taskId,
    hustlerId,
    xpAwarded: xpResult.xpAwarded,
    leveledUp: xpResult.leveledUp,
    trustUpgraded,
    errors: errors.length,
  }, 'Payout completion handler finished');
  
  return result;
}

/**
 * Verify that a task has had XP awarded
 * Used for debugging/auditing
 */
export async function verifyXPAwarded(taskId: string): Promise<{
  awarded: boolean;
  xpLedgerEntry: any | null;
}> {
  const sql = getSql();
  
  const [entry] = await sql`
    SELECT * FROM xp_ledger
    WHERE money_state_lock_task_id = ${taskId}
    LIMIT 1
  `;
  
  return {
    awarded: !!entry,
    xpLedgerEntry: entry || null,
  };
}
