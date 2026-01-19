/**
 * Trust Worker v1.0.0
 * 
 * Trust Engine MVP: Processes trust events from disputes
 * 
 * Consumes:
 * - trust.dispute_resolved.worker
 * - trust.dispute_resolved.poster
 * 
 * Responsibilities:
 * - Update users.trust_tier (demote on penalty)
 * - Set users.trust_hold (abuse pattern detection)
 * - Write trust_ledger with idempotency
 * 
 * Policy:
 * - Worker penalty: demote tier by 1 (floor 1), hold if demoted to 1 with REFUND/SPLIT
 * - Poster penalty: demote tier by 1 (floor 1), hold if 2+ penalties in 30 days
 * - Hold durations: worker (7d first, 30d second), poster (14d)
 * 
 * @see Trust Engine MVP Implementation Spec §D
 */

import { db } from '../db';
import type { Job } from 'bullmq';

// ============================================================================
// TYPES
// ============================================================================

interface TrustDisputeResolvedPayload {
  disputeId: string;
  taskId: string;
  escrowId: string;
  userId: string;
  role: 'worker' | 'poster';
  penalty: boolean;
  outcomeEscrowAction: 'RELEASE' | 'REFUND' | 'SPLIT';
  resolvedBy: string; // 'system' | 'admin:usr_xxx'
}

interface TrustJobData {
  payload: TrustDisputeResolvedPayload;
}

// ============================================================================
// TRUST WORKER
// ============================================================================

export async function processTrustJob(job: Job<TrustJobData>): Promise<void> {
  const { payload } = job.data;
  const {
    disputeId,
    taskId,
    userId,
    role,
    penalty,
    outcomeEscrowAction,
    resolvedBy,
  } = payload;

  const eventType = job.name;

  try {
    // Generate deterministic idempotency key
    const idempotencyKey = `${eventType}:${disputeId}:1`;

    // Transaction: Load user FOR UPDATE, compute changes, update, insert ledger
    await db.transaction(async (query) => {
      // Load user FOR UPDATE
      const userResult = await query<{
        id: string;
        trust_tier: number;
        trust_hold: boolean;
        trust_hold_until: Date | null;
      }>(
        'SELECT id, trust_tier, trust_hold, trust_hold_until FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new Error(`User ${userId} not found`);
      }

      const user = userResult.rows[0];
      const oldTier = user.trust_tier;

      // If no penalty, no-op (don't log to ledger for MVP)
      if (!penalty) {
        console.log(`✅ Trust event ${eventType} for user ${userId}: no penalty, skipping`);
        return;
      }

      // Compute new tier (demote by 1, floor at 1)
      const newTier = Math.max(1, oldTier - 1);

      // Compute hold conditions
      let trustHold = user.trust_hold;
      let trustHoldReason: string | null = null;
      let trustHoldUntil: Date | null = null;

      if (role === 'worker') {
        // Worker hold: if demoted to tier 1 with REFUND or SPLIT
        if (newTier === 1 && (outcomeEscrowAction === 'REFUND' || outcomeEscrowAction === 'SPLIT')) {
          // Count penalties in last 30 days (including this one)
          const penaltyCountResult = await query<{ count: string }>(
            `SELECT COUNT(*) as count
             FROM trust_ledger
             WHERE user_id = $1
               AND event_source = 'dispute'
               AND reason = 'dispute_penalty'
               AND changed_at >= NOW() - INTERVAL '30 days'`,
            [userId]
          );

          const penaltyCount = parseInt(penaltyCountResult.rows[0]?.count || '0', 10) + 1; // +1 for this penalty

          // Set hold: 7 days for first, 30 days for second+
          const holdDays = penaltyCount === 1 ? 7 : 30;
          const holdUntil = new Date();
          holdUntil.setDate(holdUntil.getDate() + holdDays);

          trustHold = true;
          trustHoldReason = `dispute_penalty_tier_1_${outcomeEscrowAction.toLowerCase()}`;
          trustHoldUntil = holdUntil;
        }
      } else if (role === 'poster') {
        // Poster hold: if 2+ penalties in last 30 days (including this one)
        const penaltyCountResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count
           FROM trust_ledger
           WHERE user_id = $1
             AND event_source = 'dispute'
             AND reason = 'dispute_penalty'
             AND changed_at >= NOW() - INTERVAL '30 days'`,
          [userId]
        );

        const penaltyCount = parseInt(penaltyCountResult.rows[0]?.count || '0', 10) + 1; // +1 for this penalty

        if (penaltyCount >= 2) {
          const holdUntil = new Date();
          holdUntil.setDate(holdUntil.getDate() + 14);

          trustHold = true;
          trustHoldReason = 'dispute_penalty_abuse_pattern';
          trustHoldUntil = holdUntil;
        }
      }

      // Update user if tier changed or hold changed
      if (oldTier !== newTier || user.trust_hold !== trustHold) {
        await query(
          `UPDATE users
           SET trust_tier = $1,
               trust_hold = $2,
               trust_hold_reason = $3,
               trust_hold_until = $4,
               updated_at = NOW()
           WHERE id = $5`,
          [newTier, trustHold, trustHoldReason, trustHoldUntil, userId]
        );

        // Insert trust_ledger entry with idempotency
        const reasonDetails = {
          disputeId,
          role,
          penalty: true,
          outcomeEscrowAction,
          oldTier,
          newTier,
          holdApplied: trustHold,
          holdUntil: trustHoldUntil?.toISOString() || null,
        };

        await query(
          `INSERT INTO trust_ledger (
            user_id,
            old_tier,
            new_tier,
            reason,
            reason_details,
            task_id,
            dispute_id,
            changed_by,
            idempotency_key,
            event_source,
            source_event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            userId,
            oldTier,
            newTier,
            'dispute_penalty',
            JSON.stringify(reasonDetails),
            taskId,
            disputeId,
            resolvedBy,
            idempotencyKey,
            'dispute',
            disputeId,
          ]
        );

        console.log(
          `✅ Trust updated for user ${userId}: tier ${oldTier} → ${newTier}, hold=${trustHold}, reason=${trustHoldReason}`
        );
      } else {
        // Tier didn't change and hold didn't change (edge case: penalty but tier already 1 and no hold condition)
        // Still log to ledger for audit (but use ON CONFLICT to handle idempotency)
        const reasonDetails = {
          disputeId,
          role,
          penalty: true,
          outcomeEscrowAction,
          oldTier,
          newTier: oldTier, // No change
          holdApplied: false,
          holdUntil: null,
        };

        await query(
          `INSERT INTO trust_ledger (
            user_id,
            old_tier,
            new_tier,
            reason,
            reason_details,
            task_id,
            dispute_id,
            changed_by,
            idempotency_key,
            event_source,
            source_event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            userId,
            oldTier,
            oldTier,
            'dispute_penalty',
            JSON.stringify(reasonDetails),
            taskId,
            disputeId,
            resolvedBy,
            idempotencyKey,
            'dispute',
            disputeId,
          ]
        );

        console.log(`✅ Trust event ${eventType} for user ${userId}: penalty but no tier/hold change (already at floor)`);
      }
    });

    console.log(`✅ Trust event ${eventType} processed for user ${userId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Trust event ${eventType} processing failed for user ${userId}: ${errorMessage}`);
    throw error; // Re-throw for BullMQ retry logic
  }
}
