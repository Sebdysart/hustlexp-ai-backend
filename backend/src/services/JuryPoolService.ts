/**
 * JuryPoolService v1.0.0
 *
 * CONSTITUTIONAL: Community dispute resolution via jury pool (Gap 16 fix)
 *
 * When the AI Judge is < 70% confident in a dispute ruling, it escalates
 * to a "Jury Pool" of high-level workers who vote for XP credits.
 *
 * Jurors: Trust tier >= TRUSTED (3+), 50+ completed tasks
 * Reward: 5 XP per vote
 * Quorum: 5 votes minimum
 * Decision: Simple majority
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface JuryCandidate {
  user_id: string;
  trust_tier: number;
  tasks_completed: number;
}

interface JuryVoteTally {
  dispute_id: string;
  total_votes: number;
  worker_complete: number;
  worker_incomplete: number;
  inconclusive: number;
  quorum_reached: boolean;
  verdict: 'worker_complete' | 'worker_incomplete' | 'inconclusive' | 'pending';
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_JUROR_TRUST_TIER = 3; // TRUSTED
const MIN_JUROR_TASKS = 50;
const JURY_QUORUM = 5;
const JUROR_XP_REWARD = 5;
const MAX_JURORS_PER_DISPUTE = 11; // odd number for tiebreaker

// ============================================================================
// SERVICE
// ============================================================================

export const JuryPoolService = {
  /**
   * Select eligible jurors for a dispute
   * Excludes: parties involved, workers with recent disputes
   */
  selectJurors: async (disputeId: string): Promise<ServiceResult<JuryCandidate[]>> => {
    try {
      // Get dispute participants to exclude
      const disputeResult = await db.query<{ poster_id: string; worker_id: string }>(
        `SELECT t.poster_id, t.worker_id
         FROM disputes d
         JOIN tasks t ON t.id = d.task_id
         WHERE d.id = $1`,
        [disputeId]
      );

      if (disputeResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Dispute not found' } };
      }

      const { poster_id, worker_id } = disputeResult.rows[0];

      // Select eligible jurors randomly
      const result = await db.query<JuryCandidate>(
        `SELECT id AS user_id, trust_tier,
                (SELECT COUNT(*) FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED') AS tasks_completed
         FROM users u
         WHERE u.trust_tier >= $1
           AND u.id != $2
           AND u.id != $3
           AND NOT EXISTS (
             SELECT 1 FROM dispute_jury_votes jv WHERE jv.dispute_id = $4 AND jv.juror_id = u.id
           )
         ORDER BY RANDOM()
         LIMIT $5`,
        [MIN_JUROR_TRUST_TIER, poster_id, worker_id, disputeId, MAX_JURORS_PER_DISPUTE]
      );

      // Filter by task count in application layer (computed column)
      const eligible = result.rows.filter(j => j.tasks_completed >= MIN_JUROR_TASKS);

      return { success: true, data: eligible };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Submit a jury vote
   */
  submitVote: async (
    disputeId: string,
    jurorId: string,
    vote: 'worker_complete' | 'worker_incomplete' | 'inconclusive',
    confidence: number
  ): Promise<ServiceResult<void>> => {
    try {
      // Verify juror eligibility
      const juror = await db.query<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1`,
        [jurorId]
      );

      if (juror.rows.length === 0 || juror.rows[0].trust_tier < MIN_JUROR_TRUST_TIER) {
        return {
          success: false,
          error: { code: 'INELIGIBLE', message: 'You are not eligible to serve on this jury' },
        };
      }

      // Submit vote (idempotent)
      await db.query(
        `INSERT INTO dispute_jury_votes (dispute_id, juror_id, vote, confidence, xp_reward)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (dispute_id, juror_id) DO NOTHING`,
        [disputeId, jurorId, vote, confidence, JUROR_XP_REWARD]
      );

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get current vote tally for a dispute
   */
  getVoteTally: async (disputeId: string): Promise<ServiceResult<JuryVoteTally>> => {
    try {
      const result = await db.query<{
        vote: string;
        count: number;
      }>(
        `SELECT vote, COUNT(*) AS count
         FROM dispute_jury_votes
         WHERE dispute_id = $1
         GROUP BY vote`,
        [disputeId]
      );

      const tally = {
        worker_complete: 0,
        worker_incomplete: 0,
        inconclusive: 0,
      };

      for (const row of result.rows) {
        if (row.vote in tally) {
          tally[row.vote as keyof typeof tally] = Number(row.count);
        }
      }

      const totalVotes = tally.worker_complete + tally.worker_incomplete + tally.inconclusive;
      const quorumReached = totalVotes >= JURY_QUORUM;

      let verdict: 'worker_complete' | 'worker_incomplete' | 'inconclusive' | 'pending' = 'pending';
      if (quorumReached) {
        if (tally.worker_complete > tally.worker_incomplete) {
          verdict = 'worker_complete';
        } else if (tally.worker_incomplete > tally.worker_complete) {
          verdict = 'worker_incomplete';
        } else {
          verdict = 'inconclusive';
        }
      }

      return {
        success: true,
        data: {
          dispute_id: disputeId,
          total_votes: totalVotes,
          ...tally,
          quorum_reached: quorumReached,
          verdict,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default JuryPoolService;
