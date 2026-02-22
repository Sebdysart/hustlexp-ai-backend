/**
 * DISPUTE RESOLUTION SERVICE
 *
 * Enhances the existing DisputeService with:
 * 1. AI-Assisted Resolution - AI analyzes evidence and recommends outcome
 * 2. Community Jury Resolution - 3 random eligible users vote on outcome
 *
 * CONSTITUTIONAL INVARIANTS ENFORCED:
 * - INV-DISP-1: Disputes can only be initiated by task participants (poster or hustler)
 * - INV-DISP-2: One active dispute per task
 * - INV-DISP-3: AI recommendations are advisory only - never auto-applied without review
 * - INV-DISP-4: Jury members must be Tier 2+ with no relation to the task
 * - INV-DISP-5: Jury requires unanimous or 2/3 majority to finalize
 * - INV-DISP-6: Finalization triggers escrow state transition (refund or release)
 * - INV-DISP-7: Evidence is immutable once dispute enters resolution phase
 * - INV-4: All money operations through escrow / StripeMoneyEngine
 *
 * DISPUTE STATE MACHINE:
 * open → evidence_collection → under_ai_review → ai_recommended
 * open → evidence_collection → jury_selection → jury_deliberation → jury_decided
 * ai_recommended | jury_decided → finalized
 *
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';
import { sql, isDatabaseAvailable, transaction } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
import { StripeMoneyEngine } from './StripeMoneyEngine.js';
import { TaskService } from './TaskService.js';
import { UserService } from './UserService.js';
import { BetaMetricsService } from './BetaMetricsService.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'DisputeResolution' });

// ============================================================================
// TYPES
// ============================================================================

export type DisputeResolutionStatus =
  | 'open'
  | 'evidence_collection'
  | 'under_ai_review'
  | 'ai_recommended'
  | 'jury_selection'
  | 'jury_deliberation'
  | 'jury_decided'
  | 'finalized'
  | 'expired';

export type ResolutionOutcome = 'poster' | 'hustler' | 'split';

export interface DisputeEvidence {
  id: string;
  disputeId: string;
  submittedBy: string;
  evidenceType: 'photo' | 'text' | 'url' | 'screenshot';
  content: string;
  description: string | null;
  createdAt: Date;
}

export interface AIRecommendation {
  outcome: ResolutionOutcome;
  confidence: number;
  reasoning: string;
  suggestedSplitPercent?: number; // Only when outcome is 'split'
  riskFlags: string[];
}

export interface JuryVote {
  jurorId: string;
  vote: 'poster' | 'hustler';
  reasoning: string;
  votedAt: Date;
}

export interface DisputeResolution {
  id: string;
  taskId: string;
  initiatorId: string;
  initiatorRole: 'poster' | 'hustler';
  posterId: string;
  hustlerId: string;
  reason: string;
  status: DisputeResolutionStatus;
  evidence: DisputeEvidence[];
  aiRecommendation: AIRecommendation | null;
  juryMembers: string[];
  juryVotes: JuryVote[];
  finalOutcome: ResolutionOutcome | null;
  refundAmountCents: number | null;
  releaseAmountCents: number | null;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
}

export interface DisputeResolutionResult {
  success: boolean;
  message: string;
  disputeId?: string;
  resolution?: Partial<DisputeResolution>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const JURY_SIZE = 3;
const JURY_MIN_TRUST_TIER = 2;
const JURY_MIN_COMPLETED_TASKS = 5;
const EVIDENCE_COLLECTION_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
const JURY_DELIBERATION_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const AI_CONFIDENCE_THRESHOLD = 0.80; // Below this, AI defers to jury

// ============================================================================
// VALID STATE TRANSITIONS
// ============================================================================

const VALID_DISPUTE_TRANSITIONS: Record<DisputeResolutionStatus, DisputeResolutionStatus[]> = {
  open:                ['evidence_collection'],
  evidence_collection: ['under_ai_review', 'jury_selection'],
  under_ai_review:     ['ai_recommended'],
  ai_recommended:      ['finalized', 'jury_selection'], // If AI confidence low, can go to jury
  jury_selection:      ['jury_deliberation'],
  jury_deliberation:   ['jury_decided'],
  jury_decided:        ['finalized'],
  finalized:           [], // Terminal
  expired:             [], // Terminal
};

function isValidDisputeTransition(from: DisputeResolutionStatus, to: DisputeResolutionStatus): boolean {
  return VALID_DISPUTE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// AI PROMPT FOR DISPUTE ANALYSIS
// ============================================================================

const DISPUTE_AI_SYSTEM_PROMPT = `You are a fair and impartial dispute resolution AI for HustleXP, a task marketplace platform.

You analyze disputes between task posters (clients) and hustlers (workers).

Your role:
1. Analyze the evidence provided by both parties
2. Consider the task description, agreed price, and completion status
3. Recommend a fair resolution

RULES:
- Be impartial. Do not favor posters or hustlers by default.
- Consider photo evidence more heavily than text claims alone.
- If the hustler completed the work as described, favor the hustler.
- If the work was not done or was substandard, favor the poster.
- If there is ambiguity or shared fault, recommend a split.
- Express your confidence level honestly. If you are unsure, say so.

OUTPUT FORMAT (JSON):
{
  "outcome": "poster" | "hustler" | "split",
  "confidence": 0.0 to 1.0,
  "reasoning": "Detailed reasoning (2-4 sentences)",
  "suggestedSplitPercent": 50,  // Only if outcome is "split" - percent to hustler
  "riskFlags": ["flag1", "flag2"]  // e.g., "possible_fraud", "missing_evidence", "unclear_scope"
}`;

// ============================================================================
// SERVICE CLASS
// ============================================================================

class DisputeResolutionServiceClass {

  // --------------------------------------------------------------------------
  // INITIATE DISPUTE
  // Either party can initiate. Creates the dispute record and begins evidence collection.
  // --------------------------------------------------------------------------
  async initiateDispute(
    taskId: string,
    initiatorId: string,
    reason: string,
    evidence: Array<{ type: 'photo' | 'text' | 'url' | 'screenshot'; content: string; description?: string }>
  ): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate task exists and is in a disputable state
      const task = await TaskService.getTask(taskId);
      if (!task) return { success: false, message: 'Task not found' };

      if (!['assigned', 'in_progress', 'completed'].includes(task.status)) {
        return { success: false, message: `Task in '${task.status}' state cannot be disputed` };
      }

      // 2. Validate initiator is a participant
      const isPoster = task.clientId === initiatorId;
      const isHustler = task.assignedHustlerId === initiatorId;

      if (!isPoster && !isHustler) {
        return { success: false, message: 'Only task participants can initiate disputes' };
      }

      if (!task.assignedHustlerId) {
        return { success: false, message: 'Cannot dispute a task with no assigned hustler' };
      }

      // 3. INV-DISP-2: Check for existing active dispute
      const [existing] = await sql`
        SELECT id FROM dispute_resolutions
        WHERE task_id = ${taskId}
          AND status NOT IN ('finalized', 'expired')
        LIMIT 1
      `;

      if (existing) {
        return {
          success: false,
          message: 'An active dispute already exists for this task',
          disputeId: existing.id,
        };
      }

      // 4. Validate minimum evidence
      if (!reason || reason.trim().length < 10) {
        return { success: false, message: 'Dispute reason must be at least 10 characters' };
      }

      // 5. Create dispute and initial evidence atomically
      const disputeId = uuidv4();
      const posterId = task.clientId;
      const hustlerId = task.assignedHustlerId;
      const initiatorRole = isPoster ? 'poster' : 'hustler';

      await transaction(async (tx) => {
        // A. Create the dispute
        await tx`
          INSERT INTO dispute_resolutions (
            id, task_id, initiator_id, initiator_role,
            poster_id, hustler_id,
            reason, status,
            created_at, updated_at
          ) VALUES (
            ${disputeId}, ${taskId}, ${initiatorId}, ${initiatorRole},
            ${posterId}, ${hustlerId},
            ${reason}, 'evidence_collection',
            NOW(), NOW()
          )
        `;

        // B. Insert evidence items
        for (const item of evidence) {
          const evidenceId = uuidv4();
          await tx`
            INSERT INTO dispute_evidence (
              id, dispute_id, submitted_by,
              evidence_type, content, description,
              created_at
            ) VALUES (
              ${evidenceId}, ${disputeId}, ${initiatorId},
              ${item.type}, ${item.content}, ${item.description || null},
              NOW()
            )
          `;
        }

        // C. Lock escrow via StripeMoneyEngine if task has escrow
        // (This is a side effect - we catch errors but don't fail the dispute)
      });

      // 6. Try to lock escrow (non-blocking - dispute creation succeeds even if this fails)
      try {
        const [moneyState] = await sql`
          SELECT current_state, amount_cents FROM money_state_lock WHERE task_id = ${taskId}
        `;

        if (moneyState && moneyState.current_state === 'held') {
          await StripeMoneyEngine.handle(taskId, 'DISPUTE_OPEN', {
            taskId,
            amountCents: Number(moneyState.amount_cents),
          }, { eventId: ulid() });

          logger.info({ disputeId, taskId }, 'Escrow locked for dispute');
        }
      } catch (escrowError) {
        logger.warn({ escrowError, disputeId, taskId }, 'Failed to lock escrow for dispute - continuing');
      }

      // 7. Update task status to disputed
      try {
        await sql`UPDATE tasks SET status = 'disputed', updated_at = NOW() WHERE id = ${taskId}`;
      } catch (taskError) {
        logger.warn({ taskError, disputeId, taskId }, 'Failed to update task status to disputed');
      }

      logger.info({
        disputeId,
        taskId,
        initiatorId,
        initiatorRole,
        evidenceCount: evidence.length,
      }, 'Dispute initiated');

      // 8. Emit metric
      try { BetaMetricsService.disputeOpened(); } catch (_) { /* non-critical */ }

      return {
        success: true,
        message: 'Dispute initiated. Evidence collection period has begun.',
        disputeId,
        resolution: {
          id: disputeId,
          taskId,
          initiatorId,
          initiatorRole: initiatorRole as 'poster' | 'hustler',
          posterId,
          hustlerId,
          reason,
          status: 'evidence_collection',
        },
      };

    } catch (error) {
      logger.error({ error, taskId, initiatorId }, 'Failed to initiate dispute');
      return { success: false, message: 'Internal error initiating dispute' };
    }
  }

  // --------------------------------------------------------------------------
  // ADD EVIDENCE
  // Either party can add evidence during the evidence_collection phase
  // --------------------------------------------------------------------------
  async addEvidence(
    disputeId: string,
    userId: string,
    evidenceItems: Array<{ type: 'photo' | 'text' | 'url' | 'screenshot'; content: string; description?: string }>
  ): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      const [dispute] = await sql`
        SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
      `;
      if (!dispute) return { success: false, message: 'Dispute not found' };

      // INV-DISP-7: Only allow evidence during evidence_collection
      if (dispute.status !== 'evidence_collection') {
        return { success: false, message: 'Evidence collection period has closed' };
      }

      // Validate user is a participant
      if (dispute.poster_id !== userId && dispute.hustler_id !== userId) {
        return { success: false, message: 'Only dispute participants can submit evidence' };
      }

      // Insert evidence
      for (const item of evidenceItems) {
        const evidenceId = uuidv4();
        await sql`
          INSERT INTO dispute_evidence (
            id, dispute_id, submitted_by,
            evidence_type, content, description,
            created_at
          ) VALUES (
            ${evidenceId}, ${disputeId}, ${userId},
            ${item.type}, ${item.content}, ${item.description || null},
            NOW()
          )
        `;
      }

      logger.info({ disputeId, userId, count: evidenceItems.length }, 'Evidence added to dispute');

      return {
        success: true,
        message: `${evidenceItems.length} evidence item(s) added`,
        disputeId,
      };

    } catch (error) {
      logger.error({ error, disputeId, userId }, 'Failed to add evidence');
      return { success: false, message: 'Internal error adding evidence' };
    }
  }

  // --------------------------------------------------------------------------
  // RESOLVE WITH AI
  // AI analyzes all evidence and produces a recommendation
  // --------------------------------------------------------------------------
  async resolveWithAI(disputeId: string): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Get dispute
      const [dispute] = await sql`
        SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
      `;
      if (!dispute) return { success: false, message: 'Dispute not found' };

      // Validate status
      if (dispute.status !== 'evidence_collection') {
        return { success: false, message: `Cannot start AI review in '${dispute.status}' status` };
      }

      // 2. Transition to under_ai_review
      await sql`
        UPDATE dispute_resolutions
        SET status = 'under_ai_review', updated_at = NOW()
        WHERE id = ${disputeId}
      `;

      // 3. Gather all context for AI
      const task = await TaskService.getTask(dispute.task_id);
      const evidence = await sql`
        SELECT * FROM dispute_evidence
        WHERE dispute_id = ${disputeId}
        ORDER BY created_at ASC
      `;

      // Build the evidence summary for AI
      const posterEvidence = evidence
        .filter((e: any) => e.submitted_by === dispute.poster_id)
        .map((e: any) => `[${e.evidence_type}] ${e.content}${e.description ? ' - ' + e.description : ''}`)
        .join('\n');

      const hustlerEvidence = evidence
        .filter((e: any) => e.submitted_by === dispute.hustler_id)
        .map((e: any) => `[${e.evidence_type}] ${e.content}${e.description ? ' - ' + e.description : ''}`)
        .join('\n');

      const userPrompt = `DISPUTE CASE:

Task: ${task?.title || 'Unknown'}
Description: ${task?.description || 'N/A'}
Category: ${task?.category || 'N/A'}
Agreed Price: $${task ? (task.recommendedPrice / 100).toFixed(2) : 'N/A'}
Task Status at Dispute: ${task?.status || 'N/A'}

DISPUTE REASON:
${dispute.reason}

POSTER'S EVIDENCE (${evidence.filter((e: any) => e.submitted_by === dispute.poster_id).length} items):
${posterEvidence || '(No evidence submitted by poster)'}

HUSTLER'S EVIDENCE (${evidence.filter((e: any) => e.submitted_by === dispute.hustler_id).length} items):
${hustlerEvidence || '(No evidence submitted by hustler)'}

Analyze this dispute and provide your recommendation in JSON format.`;

      // 4. Call AI via routed generate (dispute task type uses GPT-4o)
      let aiRecommendation: AIRecommendation;

      try {
        const aiResult = await routedGenerate('dispute', {
          system: DISPUTE_AI_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          json: true,
          maxTokens: 1024,
          temperature: 0.3, // Low temperature for consistent, conservative reasoning
        });

        const parsed = JSON.parse(aiResult.content);

        aiRecommendation = {
          outcome: parsed.outcome as ResolutionOutcome,
          confidence: Math.min(1, Math.max(0, Number(parsed.confidence))),
          reasoning: String(parsed.reasoning),
          suggestedSplitPercent: parsed.outcome === 'split' ? Number(parsed.suggestedSplitPercent) : undefined,
          riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
        };

        // Validate parsed output
        if (!['poster', 'hustler', 'split'].includes(aiRecommendation.outcome)) {
          throw new Error(`Invalid AI outcome: ${aiRecommendation.outcome}`);
        }

      } catch (aiError) {
        logger.error({ aiError, disputeId }, 'AI dispute analysis failed - defaulting to REVIEW');

        // INV-DISP-3: On AI failure, default to jury review
        aiRecommendation = {
          outcome: 'split',
          confidence: 0,
          reasoning: 'AI analysis failed. Recommending jury review.',
          riskFlags: ['ai_analysis_failed'],
        };
      }

      // 5. Store AI recommendation and transition status
      await sql`
        UPDATE dispute_resolutions
        SET status = 'ai_recommended',
            ai_outcome = ${aiRecommendation.outcome},
            ai_confidence = ${aiRecommendation.confidence},
            ai_reasoning = ${aiRecommendation.reasoning},
            ai_split_percent = ${aiRecommendation.suggestedSplitPercent || null},
            ai_risk_flags = ${aiRecommendation.riskFlags},
            updated_at = NOW()
        WHERE id = ${disputeId}
      `;

      logger.info({
        disputeId,
        outcome: aiRecommendation.outcome,
        confidence: aiRecommendation.confidence,
        riskFlags: aiRecommendation.riskFlags,
      }, 'AI dispute recommendation generated');

      // 6. If AI confidence is below threshold, recommend jury
      const needsJury = aiRecommendation.confidence < AI_CONFIDENCE_THRESHOLD;

      return {
        success: true,
        message: needsJury
          ? 'AI analysis complete but confidence is low. Jury review recommended.'
          : 'AI analysis complete with recommendation.',
        disputeId,
        resolution: {
          aiRecommendation,
          status: 'ai_recommended',
        },
      };

    } catch (error) {
      logger.error({ error, disputeId }, 'Failed to resolve dispute with AI');
      return { success: false, message: 'Internal error during AI resolution' };
    }
  }

  // --------------------------------------------------------------------------
  // RESOLVE WITH JURY
  // Select 3 random eligible users to vote on the dispute
  // --------------------------------------------------------------------------
  async resolveWithJury(disputeId: string): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Get dispute
      const [dispute] = await sql`
        SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
      `;
      if (!dispute) return { success: false, message: 'Dispute not found' };

      // Validate status - can come from evidence_collection or ai_recommended
      const currentStatus = dispute.status as DisputeResolutionStatus;
      if (!isValidDisputeTransition(currentStatus, 'jury_selection')) {
        return { success: false, message: `Cannot start jury selection in '${currentStatus}' status` };
      }

      // 2. Select eligible jurors
      // INV-DISP-4: Must be Tier 2+, not involved in the task, with sufficient history
      const eligibleJurors = await sql`
        SELECT u.id
        FROM users u
        WHERE u.trust_tier >= ${JURY_MIN_TRUST_TIER}
          AND u.id != ${dispute.poster_id}
          AND u.id != ${dispute.hustler_id}
          AND (
            SELECT COUNT(*)::int FROM tasks t
            WHERE (t.client_id = u.id OR t.assigned_hustler_id = u.id)
              AND t.status = 'completed'
          ) >= ${JURY_MIN_COMPLETED_TASKS}
          AND u.id NOT IN (
            SELECT dj.juror_id FROM dispute_jury dj
            WHERE dj.dispute_id = ${disputeId}
          )
        ORDER BY RANDOM()
        LIMIT ${JURY_SIZE * 2}
      `;

      if (eligibleJurors.length < JURY_SIZE) {
        logger.warn({
          disputeId,
          eligible: eligibleJurors.length,
          required: JURY_SIZE,
        }, 'Not enough eligible jurors');

        return {
          success: false,
          message: `Not enough eligible jurors. Found ${eligibleJurors.length}, need ${JURY_SIZE}.`,
        };
      }

      // Select exactly JURY_SIZE from the eligible pool
      const selectedJurors = eligibleJurors.slice(0, JURY_SIZE);
      const jurorIds = selectedJurors.map((j: any) => j.id as string);

      // 3. Atomically assign jury and transition status
      await transaction(async (tx) => {
        // Update dispute status
        await tx`
          UPDATE dispute_resolutions
          SET status = 'jury_deliberation',
              jury_member_ids = ${jurorIds},
              jury_deliberation_deadline = ${new Date(Date.now() + JURY_DELIBERATION_WINDOW_MS).toISOString()},
              updated_at = NOW()
          WHERE id = ${disputeId}
        `;

        // Create jury assignment records
        for (const jurorId of jurorIds) {
          await tx`
            INSERT INTO dispute_jury (
              id, dispute_id, juror_id,
              status, assigned_at
            ) VALUES (
              ${uuidv4()}, ${disputeId}, ${jurorId},
              'pending', NOW()
            )
          `;
        }
      });

      logger.info({
        disputeId,
        jurorIds,
        deliberationDeadline: new Date(Date.now() + JURY_DELIBERATION_WINDOW_MS).toISOString(),
      }, 'Jury selected and deliberation started');

      return {
        success: true,
        message: `Jury of ${JURY_SIZE} selected. Deliberation period started.`,
        disputeId,
        resolution: {
          juryMembers: jurorIds,
          status: 'jury_deliberation',
        },
      };

    } catch (error) {
      logger.error({ error, disputeId }, 'Failed to start jury resolution');
      return { success: false, message: 'Internal error starting jury resolution' };
    }
  }

  // --------------------------------------------------------------------------
  // SUBMIT JURY VOTE
  // A juror casts their vote with reasoning
  // --------------------------------------------------------------------------
  async submitJuryVote(
    disputeId: string,
    jurorId: string,
    vote: 'poster' | 'hustler',
    reasoning: string
  ): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Validate dispute
      const [dispute] = await sql`
        SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
      `;
      if (!dispute) return { success: false, message: 'Dispute not found' };

      if (dispute.status !== 'jury_deliberation') {
        return { success: false, message: 'Jury deliberation is not active for this dispute' };
      }

      // 2. Validate juror is assigned to this dispute
      const [juryRecord] = await sql`
        SELECT * FROM dispute_jury
        WHERE dispute_id = ${disputeId} AND juror_id = ${jurorId}
      `;

      if (!juryRecord) {
        return { success: false, message: 'You are not a juror for this dispute' };
      }

      if (juryRecord.status === 'voted') {
        return { success: false, message: 'You have already voted on this dispute' };
      }

      // 3. Validate reasoning length
      if (!reasoning || reasoning.trim().length < 20) {
        return { success: false, message: 'Jury reasoning must be at least 20 characters' };
      }

      // 4. Record the vote
      await sql`
        UPDATE dispute_jury
        SET status = 'voted',
            vote = ${vote},
            reasoning = ${reasoning},
            voted_at = NOW()
        WHERE dispute_id = ${disputeId} AND juror_id = ${jurorId}
      `;

      logger.info({
        disputeId,
        jurorId,
        vote,
      }, 'Jury vote submitted');

      // 5. Check if all jurors have voted
      const [voteCount] = await sql`
        SELECT
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'voted')::int as voted
        FROM dispute_jury
        WHERE dispute_id = ${disputeId}
      `;

      const allVoted = Number(voteCount.voted) >= JURY_SIZE;

      if (allVoted) {
        // Auto-transition to jury_decided
        // Tally the votes
        const votes = await sql`
          SELECT vote, COUNT(*)::int as count
          FROM dispute_jury
          WHERE dispute_id = ${disputeId} AND status = 'voted'
          GROUP BY vote
        `;

        const posterVotes = votes.find((v: any) => v.vote === 'poster')?.count || 0;
        const hustlerVotes = votes.find((v: any) => v.vote === 'hustler')?.count || 0;

        // INV-DISP-5: Determine outcome - 2/3 majority or split
        let juryOutcome: ResolutionOutcome;
        if (Number(posterVotes) >= 2) {
          juryOutcome = 'poster';
        } else if (Number(hustlerVotes) >= 2) {
          juryOutcome = 'hustler';
        } else {
          juryOutcome = 'split'; // Tie or no clear majority
        }

        await sql`
          UPDATE dispute_resolutions
          SET status = 'jury_decided',
              jury_outcome = ${juryOutcome},
              jury_poster_votes = ${Number(posterVotes)},
              jury_hustler_votes = ${Number(hustlerVotes)},
              updated_at = NOW()
          WHERE id = ${disputeId}
        `;

        logger.info({
          disputeId,
          juryOutcome,
          posterVotes: Number(posterVotes),
          hustlerVotes: Number(hustlerVotes),
        }, 'Jury deliberation complete');

        return {
          success: true,
          message: `All jurors have voted. Jury decision: ${juryOutcome}`,
          disputeId,
          resolution: {
            status: 'jury_decided',
            finalOutcome: juryOutcome,
          },
        };
      }

      return {
        success: true,
        message: `Vote recorded. ${voteCount.voted}/${JURY_SIZE} jurors have voted.`,
        disputeId,
      };

    } catch (error) {
      logger.error({ error, disputeId, jurorId }, 'Failed to submit jury vote');
      return { success: false, message: 'Internal error submitting vote' };
    }
  }

  // --------------------------------------------------------------------------
  // FINALIZE DISPUTE
  // Apply the resolution outcome: trigger escrow refund or release
  // --------------------------------------------------------------------------
  async finalizeDispute(
    disputeId: string,
    adminId?: string,
    overrideOutcome?: ResolutionOutcome
  ): Promise<DisputeResolutionResult> {
    if (!sql) throw new Error('Database not initialized');

    try {
      // 1. Get dispute
      const [dispute] = await sql`
        SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
      `;
      if (!dispute) return { success: false, message: 'Dispute not found' };

      // 2. Validate status allows finalization
      const currentStatus = dispute.status as DisputeResolutionStatus;
      if (!isValidDisputeTransition(currentStatus, 'finalized')) {
        return { success: false, message: `Cannot finalize dispute in '${currentStatus}' status` };
      }

      // 3. Determine the final outcome
      let outcome: ResolutionOutcome;
      let splitPercent = 50; // Default split: 50/50

      if (overrideOutcome && adminId) {
        // Admin override
        outcome = overrideOutcome;
        logger.warn({ disputeId, adminId, overrideOutcome }, 'Admin overriding dispute outcome');
      } else if (currentStatus === 'jury_decided') {
        outcome = dispute.jury_outcome as ResolutionOutcome;
      } else if (currentStatus === 'ai_recommended') {
        outcome = dispute.ai_outcome as ResolutionOutcome;
        if (outcome === 'split' && dispute.ai_split_percent) {
          splitPercent = Number(dispute.ai_split_percent);
        }
      } else {
        return { success: false, message: 'No resolution decision available to finalize' };
      }

      // 4. Get task and escrow details
      const task = await TaskService.getTask(dispute.task_id);
      if (!task) return { success: false, message: 'Associated task not found' };

      const [moneyState] = await sql`
        SELECT * FROM money_state_lock WHERE task_id = ${dispute.task_id}
      `;

      const taskAmountCents = moneyState
        ? Number(moneyState.amount_cents)
        : Math.round(task.recommendedPrice * 100);

      // 5. Calculate amounts based on outcome
      let refundAmountCents = 0;
      let releaseAmountCents = 0;

      switch (outcome) {
        case 'poster':
          refundAmountCents = taskAmountCents;
          releaseAmountCents = 0;
          break;
        case 'hustler':
          refundAmountCents = 0;
          releaseAmountCents = taskAmountCents;
          break;
        case 'split':
          // splitPercent is the percentage going to the hustler
          releaseAmountCents = Math.round(taskAmountCents * (splitPercent / 100));
          refundAmountCents = taskAmountCents - releaseAmountCents;
          break;
      }

      // 6. Execute the money engine operation
      const eventId = ulid();

      try {
        if (outcome === 'poster' || outcome === 'split') {
          // Refund (full or partial) to poster
          if (refundAmountCents > 0) {
            await StripeMoneyEngine.handle(dispute.task_id, 'RESOLVE_REFUND', {
              taskId: dispute.task_id,
              refundAmountCents,
              reason: 'requested_by_customer',
              disputeId,
              adminUid: adminId || 'system',
            }, { eventId });
          }
        }

        if (outcome === 'hustler') {
          // Full release to hustler
          let hustlerStripeAccountId: string | undefined;
          try {
            hustlerStripeAccountId = await UserService.getStripeConnectId(dispute.hustler_id);
          } catch (_) {
            logger.warn({ disputeId, hustlerId: dispute.hustler_id }, 'Hustler has no Stripe Connect ID');
          }

          if (hustlerStripeAccountId) {
            await StripeMoneyEngine.handle(dispute.task_id, 'RESOLVE_UPHOLD', {
              taskId: dispute.task_id,
              payoutAmountCents: releaseAmountCents,
              hustlerStripeAccountId,
              disputeId,
              adminUid: adminId || 'system',
            }, { eventId });
          }
        }
      } catch (moneyError) {
        logger.error({ moneyError, disputeId, outcome }, 'Money engine operation failed during finalization');
        // Store the outcome but mark as needing manual intervention
        await sql`
          UPDATE dispute_resolutions
          SET final_outcome = ${outcome},
              refund_amount_cents = ${refundAmountCents},
              release_amount_cents = ${releaseAmountCents},
              money_engine_error = ${(moneyError as Error).message},
              updated_at = NOW()
          WHERE id = ${disputeId}
        `;

        return {
          success: false,
          message: 'Resolution determined but money transfer failed. Admin intervention required.',
          disputeId,
        };
      }

      // 7. Finalize the dispute record
      await sql`
        UPDATE dispute_resolutions
        SET status = 'finalized',
            final_outcome = ${outcome},
            refund_amount_cents = ${refundAmountCents},
            release_amount_cents = ${releaseAmountCents},
            finalized_by = ${adminId || 'system'},
            finalized_at = NOW(),
            updated_at = NOW()
        WHERE id = ${disputeId}
      `;

      // 8. Update the linked dispute in the legacy disputes table if it exists
      try {
        await sql`
          UPDATE disputes
          SET status = ${outcome === 'poster' ? 'refunded' : 'upheld'},
              locked_at = NOW(),
              updated_at = NOW()
          WHERE task_id = ${dispute.task_id}
            AND status NOT IN ('refunded', 'upheld', 'closed')
        `;
      } catch (_) { /* Legacy table update is best-effort */ }

      logger.info({
        disputeId,
        outcome,
        refundAmountCents,
        releaseAmountCents,
        adminId: adminId || null,
      }, 'Dispute finalized');

      // 9. Emit metric
      try { BetaMetricsService.disputeResolved(outcome === 'poster' ? 'refunded' : 'upheld'); } catch (_) {}

      return {
        success: true,
        message: `Dispute finalized: ${outcome}. ${outcome === 'poster' ? 'Refund' : outcome === 'hustler' ? 'Payout' : 'Split'} processed.`,
        disputeId,
        resolution: {
          status: 'finalized',
          finalOutcome: outcome,
          refundAmountCents,
          releaseAmountCents,
        },
      };

    } catch (error) {
      logger.error({ error, disputeId }, 'Failed to finalize dispute');
      return { success: false, message: 'Internal error finalizing dispute' };
    }
  }

  // --------------------------------------------------------------------------
  // QUERY METHODS
  // --------------------------------------------------------------------------

  /**
   * Get full dispute details including evidence and jury votes
   */
  async getDispute(disputeId: string): Promise<DisputeResolution | null> {
    if (!sql) throw new Error('Database not initialized');

    const [row] = await sql`
      SELECT * FROM dispute_resolutions WHERE id = ${disputeId}
    `;
    if (!row) return null;

    // Fetch evidence
    const evidence = await sql`
      SELECT * FROM dispute_evidence
      WHERE dispute_id = ${disputeId}
      ORDER BY created_at ASC
    `;

    // Fetch jury votes
    const juryVotes = await sql`
      SELECT * FROM dispute_jury
      WHERE dispute_id = ${disputeId} AND status = 'voted'
      ORDER BY voted_at ASC
    `;

    return {
      id: row.id as string,
      taskId: row.task_id as string,
      initiatorId: row.initiator_id as string,
      initiatorRole: row.initiator_role as 'poster' | 'hustler',
      posterId: row.poster_id as string,
      hustlerId: row.hustler_id as string,
      reason: row.reason as string,
      status: row.status as DisputeResolutionStatus,
      evidence: evidence.map((e: any) => ({
        id: e.id,
        disputeId: e.dispute_id,
        submittedBy: e.submitted_by,
        evidenceType: e.evidence_type,
        content: e.content,
        description: e.description,
        createdAt: new Date(e.created_at),
      })),
      aiRecommendation: row.ai_outcome ? {
        outcome: row.ai_outcome as ResolutionOutcome,
        confidence: Number(row.ai_confidence),
        reasoning: row.ai_reasoning as string,
        suggestedSplitPercent: row.ai_split_percent ? Number(row.ai_split_percent) : undefined,
        riskFlags: (row.ai_risk_flags as string[]) || [],
      } : null,
      juryMembers: (row.jury_member_ids as string[]) || [],
      juryVotes: juryVotes.map((v: any) => ({
        jurorId: v.juror_id,
        vote: v.vote as 'poster' | 'hustler',
        reasoning: v.reasoning,
        votedAt: new Date(v.voted_at),
      })),
      finalOutcome: row.final_outcome as ResolutionOutcome | null,
      refundAmountCents: row.refund_amount_cents ? Number(row.refund_amount_cents) : null,
      releaseAmountCents: row.release_amount_cents ? Number(row.release_amount_cents) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      finalizedAt: row.finalized_at ? new Date(row.finalized_at as string) : null,
    };
  }

  /**
   * List disputes with optional filters
   */
  async listDisputes(filters?: {
    status?: DisputeResolutionStatus;
    taskId?: string;
    userId?: string;
    limit?: number;
  }): Promise<DisputeResolution[]> {
    if (!sql) throw new Error('Database not initialized');

    const limit = filters?.limit || 50;

    let rows;
    if (filters?.status && filters?.userId) {
      rows = await sql`
        SELECT * FROM dispute_resolutions
        WHERE status = ${filters.status}
          AND (poster_id = ${filters.userId} OR hustler_id = ${filters.userId})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (filters?.status) {
      rows = await sql`
        SELECT * FROM dispute_resolutions
        WHERE status = ${filters.status}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (filters?.taskId) {
      rows = await sql`
        SELECT * FROM dispute_resolutions
        WHERE task_id = ${filters.taskId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (filters?.userId) {
      rows = await sql`
        SELECT * FROM dispute_resolutions
        WHERE poster_id = ${filters.userId} OR hustler_id = ${filters.userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM dispute_resolutions
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    // Return lightweight list (no evidence/jury details)
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      initiatorId: row.initiator_id,
      initiatorRole: row.initiator_role,
      posterId: row.poster_id,
      hustlerId: row.hustler_id,
      reason: row.reason,
      status: row.status,
      evidence: [],
      aiRecommendation: row.ai_outcome ? {
        outcome: row.ai_outcome,
        confidence: Number(row.ai_confidence),
        reasoning: row.ai_reasoning || '',
        riskFlags: row.ai_risk_flags || [],
      } : null,
      juryMembers: row.jury_member_ids || [],
      juryVotes: [],
      finalOutcome: row.final_outcome || null,
      refundAmountCents: row.refund_amount_cents ? Number(row.refund_amount_cents) : null,
      releaseAmountCents: row.release_amount_cents ? Number(row.release_amount_cents) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      finalizedAt: row.finalized_at ? new Date(row.finalized_at) : null,
    }));
  }

  /**
   * Get pending jury duties for a user
   */
  async getJuryDuties(userId: string): Promise<Array<{ disputeId: string; assignedAt: Date; deadline: Date | null }>> {
    if (!sql) throw new Error('Database not initialized');

    const rows = await sql`
      SELECT dj.dispute_id, dj.assigned_at, dr.jury_deliberation_deadline
      FROM dispute_jury dj
      JOIN dispute_resolutions dr ON dr.id = dj.dispute_id
      WHERE dj.juror_id = ${userId}
        AND dj.status = 'pending'
        AND dr.status = 'jury_deliberation'
      ORDER BY dj.assigned_at ASC
    `;

    return rows.map((r: any) => ({
      disputeId: r.dispute_id,
      assignedAt: new Date(r.assigned_at),
      deadline: r.jury_deliberation_deadline ? new Date(r.jury_deliberation_deadline) : null,
    }));
  }
}

export const DisputeResolutionService = new DisputeResolutionServiceClass();
