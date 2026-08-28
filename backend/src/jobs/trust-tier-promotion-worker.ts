/**
 * Trust Tier Promotion Worker
 * 
 * Pre-Alpha Prerequisite: Background job for trust tier promotions.
 * 
 * Schedule: hourly (alpha), idempotent
 * 
 * Flow:
 * 1. Fetch candidates where trust_tier < IN_HOME
 * 2. evaluatePromotion(userId)
 * 3. If eligible → applyPromotion
 * 4. Log transition
 */

import { db } from '../db.js';
import { TrustTierService, trustTierName } from '../services/TrustTierService.js';
import { workerLogger } from '../logger.js';

const log = workerLogger.child({ worker: 'trust-tier-promotion' });

/**
 * Process trust tier promotion job
 * 
 * Evaluates all users below IN_HOME tier and promotes eligible ones.
 */
export async function processTrustTierPromotionJob(): Promise<void> {
  const startTime = Date.now();

  try {
    // Evaluate one individual-worker tier at a time, including Explorer.
    // Enterprise Crew is a separate later-phase organization model.
    const candidatesResult = await db.query<{
      id: string;
      trust_tier: number;
    }>(
      `SELECT id, trust_tier
       FROM users
       WHERE trust_tier >= 0
         AND trust_tier < 4
         AND default_mode = 'worker'
         AND account_status = 'ACTIVE'
         AND is_banned = FALSE
         AND trust_hold = FALSE
       ORDER BY trust_tier ASC, created_at ASC
       LIMIT 100`,
      []
    );

    if (candidatesResult.rowCount === 0) {
      log.info('No trust tier promotion candidates found');
      return;
    }

    let promotedCount = 0;
    let evaluatedCount = 0;

    for (const candidate of candidatesResult.rows) {
      evaluatedCount++;

      try {
        // Evaluate promotion eligibility
        const eligibility = await TrustTierService.evaluatePromotion(candidate.id);

        if (!eligibility.eligible || !eligibility.targetTier) {
          // Not eligible - log reasons for debugging
          if (eligibility.reasons.length > 0) {
            log.info({ userId: candidate.id, currentTier: candidate.trust_tier, reasons: eligibility.reasons }, 'User not eligible for trust tier promotion');
          }
          continue;
        }

        // Apply promotion
        await TrustTierService.applyPromotion(
          candidate.id,
          eligibility.targetTier,
          'system'
        );

        promotedCount++;

        log.info({ userId: candidate.id, oldTier: candidate.trust_tier, newTier: eligibility.targetTier, tierName: trustTierName(eligibility.targetTier) }, 'Trust tier promotion applied');

        // One tier per run max (safety)
        // Break after first promotion to avoid double-promotion in same run
        break;
      } catch (error) {
        // Log error but continue with other candidates
        log.error({ userId: candidate.id, err: error instanceof Error ? error.message : String(error) }, 'Failed to promote user trust tier');
      }
    }

    const latency = Date.now() - startTime;
    log.info({ evaluated: evaluatedCount, promoted: promotedCount, latencyMs: latency }, 'Trust tier promotion job completed');
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    log.error({ err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, latencyMs: latency }, 'Trust tier promotion job failed');
    
    // Don't re-throw - job runs on interval, will retry next cycle
  }
}
