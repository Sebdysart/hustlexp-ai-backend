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

import { db } from '../db';
import { TrustTierService, TrustTier } from '../services/TrustTierService';

/**
 * Process trust tier promotion job
 * 
 * Evaluates all users below IN_HOME tier and promotes eligible ones.
 */
export async function processTrustTierPromotionJob(): Promise<void> {
  const startTime = Date.now();

  try {
    // Fetch candidates where trust_tier < IN_HOME (3)
    // Also exclude BANNED (9) and UNVERIFIED (0) for now
    const candidatesResult = await db.query<{
      id: string;
      trust_tier: number;
    }>(
      `SELECT id, trust_tier
       FROM users
       WHERE trust_tier < 3
         AND trust_tier >= 1
         AND trust_hold = FALSE
       ORDER BY trust_tier ASC, created_at ASC
       LIMIT 100`,
      []
    );

    if (candidatesResult.rowCount === 0) {
      console.log('📊 No trust tier promotion candidates found');
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
            console.log(`ℹ️  User ${candidate.id} not eligible for promotion`, {
              userId: candidate.id,
              currentTier: candidate.trust_tier,
              reasons: eligibility.reasons,
            });
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

        console.log(`✅ Trust tier promotion: ${candidate.id} → ${TrustTier[eligibility.targetTier]}`, {
          userId: candidate.id,
          oldTier: candidate.trust_tier,
          newTier: eligibility.targetTier,
        });

        // One tier per run max (safety)
        // Break after first promotion to avoid double-promotion in same run
        break;
      } catch (error) {
        // Log error but continue with other candidates
        console.error(`❌ Failed to promote user ${candidate.id}`, {
          userId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const latency = Date.now() - startTime;
    console.log(`📊 Trust tier promotion job completed`, {
      evaluated: evaluatedCount,
      promoted: promotedCount,
      latency,
    });
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    console.error(`❌ Trust tier promotion job failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      latency,
      stage: 'trust_tier_promotion',
    });
    
    // Don't re-throw - job runs on interval, will retry next cycle
  }
}
