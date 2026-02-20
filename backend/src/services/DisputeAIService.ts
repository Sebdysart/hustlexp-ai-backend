/**
 * DisputeAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Analyzes dispute evidence and produces resolution PROPOSALS for admin review.
 * Cannot resolve disputes directly — all proposals go through admin decision flow.
 *
 * Methods:
 *   analyzeDispute(disputeId)          — Deep analysis via DeepSeek reasoning route
 *   generateEvidenceRequest(disputeId) — Auto-generate questions via Groq fast route
 *   assessEscalation(disputeId)        — Escalation recommendation
 *
 * Deterministic fallbacks for each method when AI is unavailable.
 *
 * @see DisputeService.ts (state machine: OPEN -> EVIDENCE_REQUESTED -> RESOLVED/ESCALATED)
 * @see schema.sql v1.8.0 (ai_agent_decisions)
 * @see AI_INFRASTRUCTURE.md §7.3
 */

import { db } from '../db';
import type { ServiceResult, Dispute, Task, Escrow, Evidence } from '../types';
import { AIClient } from './AIClient';
import { aiLogger } from '../logger';

const log = aiLogger.child({ service: 'DisputeAIService' });

// ============================================================================
// TYPES
// ============================================================================

interface FaultAssessment {
  poster_fault_score: number;  // 0-1
  worker_fault_score: number;  // 0-1
  unclear_score: number;       // 0-1 (sum of all three = 1.0)
}

interface SplitRatio {
  worker_pct: number;
  poster_pct: number;
}

interface DisputeAnalysis {
  summary: string;
  fault_assessment: FaultAssessment;
  recommended_action: 'RELEASE' | 'REFUND' | 'SPLIT';
  split_ratio?: SplitRatio;
  reasoning: string;
  confidence: number;
  precedent_signals: string[];
  escalation_recommended: boolean;
}

interface EvidenceRequest {
  poster_questions: string[];
  worker_questions: string[];
}

interface EscalationAssessment {
  shouldEscalate: boolean;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
}

// Internal: dispute context gathered for AI analysis
interface DisputeContext {
  dispute: Dispute;
  task: Task;
  escrow: Escrow;
  evidence: Evidence[];
  posterHistory: { total_disputes: number; total_tasks: number; trust_tier: number };
  workerHistory: { total_disputes: number; total_tasks: number; trust_tier: number };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const HIGH_VALUE_THRESHOLD_CENTS = 20000;  // $200 — always recommend escalation
const LOW_VALUE_THRESHOLD_CENTS = 5000;    // $50 — eligible for auto-recommendation

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Gather all context needed for dispute analysis
 */
async function gatherDisputeContext(disputeId: string): Promise<ServiceResult<DisputeContext>> {
  try {
    // Fetch dispute
    const disputeResult = await db.query<Dispute>(
      'SELECT * FROM disputes WHERE id = $1',
      [disputeId]
    );
    if (disputeResult.rows.length === 0) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Dispute ${disputeId} not found` },
      };
    }
    const dispute = disputeResult.rows[0];

    // Fetch task
    const taskResult = await db.query<Task>(
      'SELECT * FROM tasks WHERE id = $1',
      [dispute.task_id]
    );
    if (taskResult.rows.length === 0) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Task ${dispute.task_id} not found` },
      };
    }
    const task = taskResult.rows[0];

    // Fetch escrow
    const escrowResult = await db.query<Escrow>(
      'SELECT * FROM escrows WHERE id = $1',
      [dispute.escrow_id]
    );
    if (escrowResult.rows.length === 0) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Escrow ${dispute.escrow_id} not found` },
      };
    }
    const escrow = escrowResult.rows[0];

    // Fetch evidence submissions
    const evidenceResult = await db.query<Evidence>(
      'SELECT * FROM evidence WHERE dispute_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [disputeId]
    );

    // Fetch poster dispute history
    const posterHistoryResult = await db.query<{ total_disputes: string; total_tasks: string; trust_tier: number }>(
      `SELECT
        (SELECT COUNT(*) FROM disputes WHERE poster_id = $1 OR worker_id = $1) AS total_disputes,
        (SELECT COUNT(*) FROM tasks WHERE poster_id = $1) AS total_tasks,
        trust_tier
       FROM users WHERE id = $1`,
      [dispute.poster_id]
    );
    const posterRow = posterHistoryResult.rows[0];
    const posterHistory = posterRow
      ? { total_disputes: parseInt(posterRow.total_disputes, 10), total_tasks: parseInt(posterRow.total_tasks, 10), trust_tier: posterRow.trust_tier }
      : { total_disputes: 0, total_tasks: 0, trust_tier: 1 };

    // Fetch worker dispute history
    const workerHistoryResult = await db.query<{ total_disputes: string; total_tasks: string; trust_tier: number }>(
      `SELECT
        (SELECT COUNT(*) FROM disputes WHERE poster_id = $1 OR worker_id = $1) AS total_disputes,
        (SELECT COUNT(*) FROM tasks WHERE worker_id = $1) AS total_tasks,
        trust_tier
       FROM users WHERE id = $1`,
      [dispute.worker_id]
    );
    const workerRow = workerHistoryResult.rows[0];
    const workerHistory = workerRow
      ? { total_disputes: parseInt(workerRow.total_disputes, 10), total_tasks: parseInt(workerRow.total_tasks, 10), trust_tier: workerRow.trust_tier }
      : { total_disputes: 0, total_tasks: 0, trust_tier: 1 };

    return {
      success: true,
      data: {
        dispute,
        task,
        escrow,
        evidence: evidenceResult.rows,
        posterHistory,
        workerHistory,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Failed to gather dispute context',
      },
    };
  }
}

/**
 * Log AI proposal to ai_agent_decisions table.
 * Uses task_id as the foreign key; dispute_id is stored in the proposal JSON.
 */
async function logDisputeProposal(
  taskId: string,
  disputeId: string,
  proposal: Record<string, unknown>,
  confidence: number,
  reasoning: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ai_agent_decisions (
        agent_type, task_id, proposal, confidence_score, reasoning, authority_level
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'dispute',
        taskId,
        JSON.stringify({ ...proposal, dispute_id: disputeId }),
        confidence,
        reasoning,
        'A2',
      ]
    );
  } catch (error) {
    // Non-fatal: log failure should not break the analysis flow
    // The CHECK constraint may not include 'dispute' yet — warn but continue
    log.warn({ err: error instanceof Error ? error.message : String(error), taskId, disputeId }, 'Failed to log proposal to ai_agent_decisions');
  }
}

// ============================================================================
// DETERMINISTIC FALLBACKS
// ============================================================================

/**
 * Rule-based dispute analysis when AI is unavailable
 */
function deterministicAnalysis(ctx: DisputeContext): DisputeAnalysis {
  const { dispute, task, escrow, evidence } = ctx;
  const amountCents = escrow.amount;

  // High-value disputes always recommend escalation
  if (amountCents > HIGH_VALUE_THRESHOLD_CENTS) {
    return {
      summary: `High-value dispute ($${(amountCents / 100).toFixed(2)}) for task "${task.title}". Automatic escalation recommended due to amount.`,
      fault_assessment: { poster_fault_score: 0.33, worker_fault_score: 0.33, unclear_score: 0.34 },
      recommended_action: 'SPLIT',
      split_ratio: { worker_pct: 50, poster_pct: 50 },
      reasoning: `Escrow amount ($${(amountCents / 100).toFixed(2)}) exceeds $200 threshold. Rule-based fallback recommends escalation for human review.`,
      confidence: 0.3,
      precedent_signals: [],
      escalation_recommended: true,
    };
  }

  // Task was COMPLETED with proof accepted — favor worker
  const hasAcceptedProof = task.state === 'COMPLETED' && task.proof_submitted_at;
  if (hasAcceptedProof) {
    // Check if there's strong counter-evidence from poster
    const posterEvidence = evidence.filter(e => e.uploader_user_id === dispute.poster_id);
    if (posterEvidence.length === 0 && amountCents < LOW_VALUE_THRESHOLD_CENTS) {
      return {
        summary: `Task "${task.title}" was completed with proof submitted. No counter-evidence from poster. Recommend release to worker.`,
        fault_assessment: { poster_fault_score: 0.7, worker_fault_score: 0.1, unclear_score: 0.2 },
        recommended_action: 'RELEASE',
        reasoning: 'Task marked COMPLETED with proof submitted. No counter-evidence. Low-value dispute. Rule-based recommendation: release to worker.',
        confidence: 0.7,
        precedent_signals: ['completed_with_proof', 'no_counter_evidence'],
        escalation_recommended: false,
      };
    }
  }

  // Poster initiated dispute with evidence — favor poster for low-value
  const posterInitiated = dispute.initiated_by === dispute.poster_id;
  const posterEvidence = evidence.filter(e => e.uploader_user_id === dispute.poster_id);
  const workerEvidence = evidence.filter(e => e.uploader_user_id === dispute.worker_id);

  if (posterInitiated && posterEvidence.length > 0 && workerEvidence.length === 0 && amountCents < LOW_VALUE_THRESHOLD_CENTS) {
    return {
      summary: `Poster-initiated dispute for "${task.title}". Poster provided evidence, worker has not responded. Recommend refund.`,
      fault_assessment: { poster_fault_score: 0.1, worker_fault_score: 0.7, unclear_score: 0.2 },
      recommended_action: 'REFUND',
      reasoning: 'Poster provided evidence, worker has not. Low-value dispute. Rule-based recommendation: refund to poster.',
      confidence: 0.6,
      precedent_signals: ['poster_evidence_only', 'worker_no_response'],
      escalation_recommended: false,
    };
  }

  // Default: unclear — recommend split and escalation
  return {
    summary: `Dispute for task "${task.title}" ($${(amountCents / 100).toFixed(2)}). Both parties may have valid claims. Recommend admin review.`,
    fault_assessment: { poster_fault_score: 0.33, worker_fault_score: 0.33, unclear_score: 0.34 },
    recommended_action: 'SPLIT',
    split_ratio: { worker_pct: 50, poster_pct: 50 },
    reasoning: 'Insufficient signal for automated determination. Rule-based fallback recommends 50/50 split with admin escalation.',
    confidence: 0.4,
    precedent_signals: [],
    escalation_recommended: true,
  };
}

/**
 * Rule-based evidence request generation
 */
function deterministicEvidenceRequest(ctx: DisputeContext): EvidenceRequest {
  const { dispute, task } = ctx;

  const posterQuestions: string[] = [
    `Please describe what went wrong with the task "${task.title}".`,
    'Do you have any photos or screenshots that support your claim?',
    'Did you communicate with the worker about the issue before filing this dispute?',
  ];

  const workerQuestions: string[] = [
    `Please describe how you completed the task "${task.title}".`,
    'Do you have any photos or proof of completion?',
    'Were there any issues or changes to the original task requirements?',
  ];

  // Add reason-specific questions
  const reason = dispute.reason.toLowerCase();
  if (reason.includes('quality') || reason.includes('incomplete')) {
    posterQuestions.push('What specific aspects of the work did not meet your expectations?');
    workerQuestions.push('Were there any constraints that prevented you from completing the task fully?');
  }
  if (reason.includes('no-show') || reason.includes('absent')) {
    posterQuestions.push('At what time and location were you expecting the worker?');
    workerQuestions.push('Did you arrive at the task location? If so, at what time?');
  }
  if (reason.includes('damage') || reason.includes('broken')) {
    posterQuestions.push('Please provide photos of the damage and an estimate of repair costs.');
    workerQuestions.push('Were there any pre-existing conditions or fragile items you were not warned about?');
  }

  return { poster_questions: posterQuestions, worker_questions: workerQuestions };
}

/**
 * Rule-based escalation assessment
 */
function deterministicEscalation(ctx: DisputeContext): EscalationAssessment {
  const { escrow, posterHistory, workerHistory, evidence } = ctx;
  const amountCents = escrow.amount;

  // High-value: always escalate
  if (amountCents > HIGH_VALUE_THRESHOLD_CENTS) {
    return {
      shouldEscalate: true,
      reason: `High-value dispute ($${(amountCents / 100).toFixed(2)} exceeds $200 threshold). Requires admin review.`,
      urgency: 'high',
    };
  }

  // Repeat disputers: escalate
  if (posterHistory.total_disputes > 3 || workerHistory.total_disputes > 3) {
    return {
      shouldEscalate: true,
      reason: 'One or both parties have elevated dispute history. Possible pattern detected.',
      urgency: 'medium',
    };
  }

  // Low trust tier users: escalate
  if (posterHistory.trust_tier <= 1 || workerHistory.trust_tier <= 1) {
    return {
      shouldEscalate: true,
      reason: 'One or both parties have low trust tier. Escalation recommended for safety.',
      urgency: 'medium',
    };
  }

  // No evidence from either side: escalate for evidence request
  if (evidence.length === 0) {
    return {
      shouldEscalate: false,
      reason: 'No evidence submitted yet. Request evidence before escalation.',
      urgency: 'low',
    };
  }

  // Low-value with clear evidence: no escalation needed
  if (amountCents < LOW_VALUE_THRESHOLD_CENTS && evidence.length > 0) {
    return {
      shouldEscalate: false,
      reason: `Low-value dispute ($${(amountCents / 100).toFixed(2)}) with evidence available. Can be resolved without escalation.`,
      urgency: 'low',
    };
  }

  // Default: moderate escalation
  return {
    shouldEscalate: true,
    reason: 'Dispute complexity warrants admin review.',
    urgency: 'medium',
  };
}

// ============================================================================
// SERVICE
// ============================================================================

export const DisputeAIService = {
  /**
   * Deep analysis of a dispute.
   * Uses AI (DeepSeek reasoning route) with deterministic fallback.
   * Returns a PROPOSAL — admin makes final decision.
   */
  analyzeDispute: async (disputeId: string): Promise<ServiceResult<DisputeAnalysis>> => {
    try {
      // 1. Gather context
      const ctxResult = await gatherDisputeContext(disputeId);
      if (!ctxResult.success) return ctxResult;
      const ctx = ctxResult.data;

      let analysis: DisputeAnalysis;

      // 2. Try AI analysis, fall back to deterministic rules
      if (AIClient.isConfigured()) {
        try {
          const evidenceSummary = ctx.evidence.length > 0
            ? ctx.evidence.map(e => `[${e.uploader_user_id === ctx.dispute.poster_id ? 'Poster' : 'Worker'}] ${e.content_type} uploaded ${new Date(e.created_at).toISOString()}`).join('\n')
            : 'No evidence submitted yet.';

          const aiResult = await AIClient.callJSON<DisputeAnalysis>({
            route: 'reasoning',
            temperature: 0.2,
            timeoutMs: 45000,
            maxTokens: 2048,
            enableCache: false,
            systemPrompt: `You are HustleXP's Dispute Mediation AI (A2 authority — proposal only).
Analyze dispute evidence and produce a resolution PROPOSAL. You CANNOT resolve disputes directly.
Admins will review your proposal and make the final decision.

IMPORTANT RULES:
- fault_assessment scores MUST sum to exactly 1.0
- confidence must be 0.0-1.0 (lower = more uncertain)
- If confidence < 0.5, set escalation_recommended = true
- recommended_action must be RELEASE, REFUND, or SPLIT
- If SPLIT, include split_ratio with worker_pct + poster_pct = 100
- precedent_signals: list patterns you observe (e.g. "completed_with_proof", "no_evidence_from_worker")

Return JSON with EXACTLY these fields:
- summary: string (2-3 sentence summary)
- fault_assessment: { poster_fault_score: number, worker_fault_score: number, unclear_score: number }
- recommended_action: "RELEASE" | "REFUND" | "SPLIT"
- split_ratio: { worker_pct: number, poster_pct: number } (only if SPLIT)
- reasoning: string (detailed explanation)
- confidence: number (0.0-1.0)
- precedent_signals: string[]
- escalation_recommended: boolean`,
            prompt: `Analyze this dispute and propose a resolution:

DISPUTE:
- ID: ${ctx.dispute.id}
- Reason: ${ctx.dispute.reason}
- Description: ${ctx.dispute.description}
- Initiated by: ${ctx.dispute.initiated_by === ctx.dispute.poster_id ? 'POSTER' : 'WORKER'}
- State: ${ctx.dispute.state}

TASK:
- Title: ${ctx.task.title}
- Description: ${ctx.task.description}
- Price: $${(ctx.task.price / 100).toFixed(2)}
- State: ${ctx.task.state}
- Completed: ${ctx.task.completed_at ? 'Yes' : 'No'}
- Proof submitted: ${ctx.task.proof_submitted_at ? 'Yes' : 'No'}

ESCROW:
- Amount: $${(ctx.escrow.amount / 100).toFixed(2)}
- State: ${ctx.escrow.state}

EVIDENCE:
${evidenceSummary}

USER HISTORIES:
- Poster: ${ctx.posterHistory.total_tasks} tasks, ${ctx.posterHistory.total_disputes} disputes, trust tier ${ctx.posterHistory.trust_tier}
- Worker: ${ctx.workerHistory.total_tasks} tasks, ${ctx.workerHistory.total_disputes} disputes, trust tier ${ctx.workerHistory.trust_tier}`,
          });

          analysis = aiResult.data;

          // Validate fault_assessment sums to 1.0 (within tolerance)
          const faultSum = analysis.fault_assessment.poster_fault_score
            + analysis.fault_assessment.worker_fault_score
            + analysis.fault_assessment.unclear_score;
          if (Math.abs(faultSum - 1.0) > 0.05) {
            log.warn({ faultSum, disputeId }, 'Fault scores do not sum to 1.0, normalizing');
            analysis.fault_assessment.poster_fault_score /= faultSum;
            analysis.fault_assessment.worker_fault_score /= faultSum;
            analysis.fault_assessment.unclear_score /= faultSum;
          }

          // Validate split_ratio if SPLIT
          if (analysis.recommended_action === 'SPLIT') {
            if (!analysis.split_ratio) {
              analysis.split_ratio = { worker_pct: 50, poster_pct: 50 };
            } else {
              const ratioSum = analysis.split_ratio.worker_pct + analysis.split_ratio.poster_pct;
              if (Math.abs(ratioSum - 100) > 1) {
                analysis.split_ratio.worker_pct = Math.round((analysis.split_ratio.worker_pct / ratioSum) * 100);
                analysis.split_ratio.poster_pct = 100 - analysis.split_ratio.worker_pct;
              }
            }
          }

          // Clamp confidence
          analysis.confidence = Math.max(0, Math.min(1, analysis.confidence));

          log.info({ action: analysis.recommended_action, confidence: analysis.confidence, escalate: analysis.escalation_recommended, provider: aiResult.provider, disputeId }, 'AI dispute analysis complete');
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? (aiError as Error).message : String(aiError), disputeId }, 'AI analysis failed, using deterministic fallback');
          analysis = deterministicAnalysis(ctx);
        }
      } else {
        analysis = deterministicAnalysis(ctx);
      }

      // 3. Log proposal to ai_agent_decisions
      await logDisputeProposal(
        ctx.dispute.task_id,
        disputeId,
        analysis as unknown as Record<string, unknown>,
        analysis.confidence,
        analysis.reasoning,
      );

      return { success: true, data: analysis };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), disputeId }, 'Failed to analyze dispute');
      return {
        success: false,
        error: {
          code: 'DISPUTE_ANALYSIS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to analyze dispute',
        },
      };
    }
  },

  /**
   * Generate targeted evidence request questions for both parties.
   * Uses AI (Groq fast route) with deterministic fallback.
   */
  generateEvidenceRequest: async (disputeId: string): Promise<ServiceResult<EvidenceRequest>> => {
    try {
      const ctxResult = await gatherDisputeContext(disputeId);
      if (!ctxResult.success) return ctxResult;
      const ctx = ctxResult.data;

      let evidenceRequest: EvidenceRequest;

      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<EvidenceRequest>({
            route: 'fast',
            temperature: 0.3,
            timeoutMs: 10000,
            maxTokens: 1024,
            systemPrompt: `You are HustleXP's Dispute Evidence Request Generator.
Generate specific, targeted questions for both the poster and worker in a dispute.
Questions should help gather evidence to resolve the dispute fairly.

Return JSON with EXACTLY these fields:
- poster_questions: string[] (3-5 specific questions for the poster)
- worker_questions: string[] (3-5 specific questions for the worker)

Questions should be:
- Specific to the dispute reason and task type
- Non-leading (don't assume fault)
- Actionable (ask for concrete evidence: photos, timestamps, messages)`,
            prompt: `Generate evidence request questions for this dispute:

Dispute reason: ${ctx.dispute.reason}
Description: ${ctx.dispute.description}
Task: "${ctx.task.title}" — ${ctx.task.description}
Task price: $${(ctx.task.price / 100).toFixed(2)}
Initiated by: ${ctx.dispute.initiated_by === ctx.dispute.poster_id ? 'POSTER' : 'WORKER'}
Evidence already submitted: ${ctx.evidence.length} items`,
          });

          evidenceRequest = aiResult.data;

          // Validate arrays exist and have content
          if (!Array.isArray(evidenceRequest.poster_questions) || evidenceRequest.poster_questions.length === 0) {
            throw new Error('AI returned empty poster_questions');
          }
          if (!Array.isArray(evidenceRequest.worker_questions) || evidenceRequest.worker_questions.length === 0) {
            throw new Error('AI returned empty worker_questions');
          }

          log.info({ posterQuestionCount: evidenceRequest.poster_questions.length, workerQuestionCount: evidenceRequest.worker_questions.length, provider: aiResult.provider, disputeId }, 'Generated evidence request questions');
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? (aiError as Error).message : String(aiError), disputeId }, 'AI evidence request failed, using deterministic fallback');
          evidenceRequest = deterministicEvidenceRequest(ctx);
        }
      } else {
        evidenceRequest = deterministicEvidenceRequest(ctx);
      }

      // Log proposal
      await logDisputeProposal(
        ctx.dispute.task_id,
        disputeId,
        { type: 'evidence_request', ...evidenceRequest },
        0.8,
        `Generated evidence request: ${evidenceRequest.poster_questions.length} poster questions, ${evidenceRequest.worker_questions.length} worker questions`,
      );

      return { success: true, data: evidenceRequest };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), disputeId }, 'Failed to generate evidence request');
      return {
        success: false,
        error: {
          code: 'EVIDENCE_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Failed to generate evidence request',
        },
      };
    }
  },

  /**
   * Assess whether a dispute should be escalated to admin.
   * Checks: amount, user histories, complexity, fraud signals.
   */
  assessEscalation: async (disputeId: string): Promise<ServiceResult<EscalationAssessment>> => {
    try {
      const ctxResult = await gatherDisputeContext(disputeId);
      if (!ctxResult.success) return ctxResult;
      const ctx = ctxResult.data;

      // Escalation assessment is always deterministic — no AI needed for this.
      // The decision is rule-based on concrete thresholds.
      const assessment = deterministicEscalation(ctx);

      // Log proposal
      await logDisputeProposal(
        ctx.dispute.task_id,
        disputeId,
        { type: 'escalation_assessment', ...assessment },
        assessment.shouldEscalate ? 0.9 : 0.8,
        assessment.reason,
      );

      log.info({ escalate: assessment.shouldEscalate, urgency: assessment.urgency, disputeId }, 'Escalation assessment complete');

      return { success: true, data: assessment };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), disputeId }, 'Failed to assess escalation');
      return {
        success: false,
        error: {
          code: 'ESCALATION_ASSESSMENT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to assess escalation',
        },
      };
    }
  },
};

export default DisputeAIService;
