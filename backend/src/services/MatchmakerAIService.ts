/**
 * MatchmakerAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Provides intelligent task-worker matching with explanations.
 * Cannot directly assign workers to tasks - proposals validated by deterministic rules.
 *
 * Methods:
 *   rankCandidates   - Rank candidate workers for a task with reasoning
 *   explainMatch     - "Why this task?" explanation for iOS app
 *   suggestPrice     - Lightweight price hint for posters (heuristic-first)
 *
 * @see AI_INFRASTRUCTURE.md
 * @see schema.sql v1.8.0 (ai_agent_decisions)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { AIClient } from './AIClient';
import { aiLogger } from '../logger';

const log = aiLogger.child({ service: 'MatchmakerAIService' });

// ============================================================================
// TYPES
// ============================================================================

export interface MatchCandidate {
  userId: string;
  rank: number;
  matchScore: number;
  reasoning: string;
  factors: {
    skillMatch: number;
    proximity: number;
    reliability: number;
    trustTier: number;
    availability: number;
  };
}

export interface MatchExplanation {
  summary: string;
  factors: string[];
  estimatedEarnings: number;
  estimatedDuration: string;
}

export interface PriceSuggestion {
  suggested_price_cents: number;
  range_low_cents: number;
  range_high_cents: number;
  reasoning: string;
  confidence: number;
}

interface CandidateInput {
  userId: string;
  skills?: string[];
  location?: { latitude: number; longitude: number };
  trustTier: number;
  completedTasks: number;
  completionRate: number;
  averageRating?: number;
  isAvailable: boolean;
}

interface TaskInput {
  id: string;
  title: string;
  description: string;
  category?: string;
  location?: string;
  price: number;
  requirements?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_RANKED_CANDIDATES = 10;
const MIN_PRICE_CENTS = 1500;   // $15 minimum
const MAX_PRICE_CENTS = 50000;  // $500 maximum

/** Category-based base pricing heuristics (in cents) */
const CATEGORY_BASE_PRICES: Record<string, number> = {
  delivery: 2500,
  moving: 8000,
  cleaning: 4000,
  handyman: 10000,
  errands: 2000,
  gardening: 5000,
  tutoring: 6000,
  tech_help: 7000,
  pet_care: 3500,
  general: 3000,
};

/** Heuristic confidence threshold - below this, use AI for price suggestion */
const HEURISTIC_CONFIDENCE_THRESHOLD = 0.70;

// ============================================================================
// SERVICE
// ============================================================================

export const MatchmakerAIService = {
  /**
   * Rank candidate workers for a given task.
   *
   * Uses AIClient 'fast' route (Groq) for low latency.
   * Falls back to deterministic scoring when AI is unavailable.
   *
   * @returns Top 10 ranked candidates with scores and reasoning
   */
  rankCandidates: async (
    task: TaskInput,
    candidates: CandidateInput[]
  ): Promise<ServiceResult<MatchCandidate[]>> => {
    try {
      if (candidates.length === 0) {
        return { success: true, data: [] };
      }

      let ranked: MatchCandidate[];

      if (AIClient.isConfigured()) {
        try {
          const candidateSummaries = candidates.map((c, i) => ({
            index: i,
            userId: c.userId,
            skills: c.skills || [],
            trustTier: c.trustTier,
            completedTasks: c.completedTasks,
            completionRate: c.completionRate,
            averageRating: c.averageRating ?? null,
            isAvailable: c.isAvailable,
            hasLocation: !!c.location,
          }));

          const aiResult = await AIClient.callJSON<{
            rankings: Array<{
              index: number;
              matchScore: number;
              reasoning: string;
              factors: {
                skillMatch: number;
                proximity: number;
                reliability: number;
                trustTier: number;
                availability: number;
              };
            }>;
          }>({
            route: 'fast',
            temperature: 0.3,
            timeoutMs: 10000,
            maxTokens: 2048,
            systemPrompt: `You are HustleXP's Matchmaker Agent (A2 authority - proposal only).
Rank candidate workers for a task based on fit. You CANNOT assign workers.

SCORING FACTORS (each 0.0-1.0):
- skillMatch: How well candidate skills align with task requirements
- proximity: Location closeness (1.0 = very close, 0.5 = unknown)
- reliability: Based on completion rate and completed task count
- trustTier: Normalized trust tier (tier/4)
- availability: 1.0 if available, 0.0 if not

RULES:
- matchScore = weighted average of factors (skills 0.30, proximity 0.20, reliability 0.25, trustTier 0.15, availability 0.10)
- Only include candidates with matchScore >= 0.30
- Return max ${MAX_RANKED_CANDIDATES} candidates, sorted by matchScore descending
- Each reasoning must be 1-2 sentences explaining the match

Return JSON: { "rankings": [{ "index": number, "matchScore": number, "reasoning": string, "factors": { "skillMatch": number, "proximity": number, "reliability": number, "trustTier": number, "availability": number } }] }`,
            prompt: `Task: "${task.title}"
Description: ${task.description}
Category: ${task.category || 'general'}
Location: ${task.location || 'not specified'}
Price: $${(task.price / 100).toFixed(2)}
Requirements: ${task.requirements || 'none specified'}

Candidates:
${JSON.stringify(candidateSummaries, null, 2)}`,
          });

          ranked = aiResult.data.rankings
            .slice(0, MAX_RANKED_CANDIDATES)
            .map((r, rank) => ({
              userId: candidates[r.index]?.userId ?? candidates[0].userId,
              rank: rank + 1,
              matchScore: Math.max(0, Math.min(1, r.matchScore)),
              reasoning: r.reasoning,
              factors: {
                skillMatch: Math.max(0, Math.min(1, r.factors.skillMatch)),
                proximity: Math.max(0, Math.min(1, r.factors.proximity)),
                reliability: Math.max(0, Math.min(1, r.factors.reliability)),
                trustTier: Math.max(0, Math.min(1, r.factors.trustTier)),
                availability: Math.max(0, Math.min(1, r.factors.availability)),
              },
            }));

          log.info({ rankedCount: ranked.length, taskId: task.id, provider: aiResult.provider }, 'AI ranked candidates for task');
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? (aiError as Error).message : String(aiError), taskId: task.id }, 'AI ranking call failed, using deterministic fallback');
          ranked = MatchmakerAIService._rankDeterministic(task, candidates);
        }
      } else {
        ranked = MatchmakerAIService._rankDeterministic(task, candidates);
      }

      // Log decision
      await MatchmakerAIService._logDecision(
        task.id,
        { type: 'rank_candidates', candidateCount: candidates.length, resultCount: ranked.length },
        ranked.length > 0 ? ranked[0].matchScore : 0,
        `Ranked ${ranked.length} candidates for task "${task.title}"`
      );

      return { success: true, data: ranked };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId: task.id }, 'Failed to rank candidates');
      return {
        success: false,
        error: {
          code: 'RANK_CANDIDATES_FAILED',
          message: error instanceof Error ? error.message : 'Failed to rank candidates',
        },
      };
    }
  },

  /**
   * Explain why a task was recommended to a specific worker.
   * Used by the iOS app "Why this task?" feature.
   *
   * @returns Human-readable explanation (max 3 sentences)
   */
  explainMatch: async (
    task: TaskInput,
    worker: CandidateInput
  ): Promise<ServiceResult<MatchExplanation>> => {
    try {
      let explanation: MatchExplanation;

      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<{
            summary: string;
            factors: string[];
            estimatedEarnings: number;
            estimatedDuration: string;
          }>({
            route: 'fast',
            temperature: 0.3,
            timeoutMs: 8000,
            maxTokens: 512,
            systemPrompt: `You are HustleXP's Matchmaker Agent explaining task recommendations.
Generate a concise, encouraging explanation for why a task was recommended to a worker.

RULES:
- summary: Max 3 sentences, conversational tone, mention specific strengths
- factors: Array of 2-4 short bullet points (skill alignment, earnings, distance, time)
- estimatedEarnings: Task price in cents (after platform fee ~15%)
- estimatedDuration: Human-readable time estimate (e.g., "30-45 min", "1-2 hours")

Return JSON: { "summary": string, "factors": string[], "estimatedEarnings": number, "estimatedDuration": string }`,
            prompt: `Task: "${task.title}"
Description: ${task.description}
Category: ${task.category || 'general'}
Location: ${task.location || 'not specified'}
Price: $${(task.price / 100).toFixed(2)}

Worker profile:
- Skills: ${(worker.skills || []).join(', ') || 'general'}
- Trust tier: ${worker.trustTier}/4
- Completed tasks: ${worker.completedTasks}
- Completion rate: ${(worker.completionRate * 100).toFixed(0)}%
- Average rating: ${worker.averageRating ?? 'N/A'}`,
          });

          explanation = {
            summary: aiResult.data.summary,
            factors: aiResult.data.factors,
            estimatedEarnings: aiResult.data.estimatedEarnings,
            estimatedDuration: aiResult.data.estimatedDuration,
          };

          log.info({ taskId: task.id, workerId: worker.userId, provider: aiResult.provider }, 'Generated match explanation');
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? (aiError as Error).message : String(aiError), taskId: task.id, workerId: worker.userId }, 'AI explain failed, using deterministic fallback');
          explanation = MatchmakerAIService._explainDeterministic(task, worker);
        }
      } else {
        explanation = MatchmakerAIService._explainDeterministic(task, worker);
      }

      // Log decision
      await MatchmakerAIService._logDecision(
        task.id,
        { type: 'explain_match', workerId: worker.userId },
        0.9, // Explanation confidence is inherently high
        explanation.summary
      );

      return { success: true, data: explanation };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId: task.id, workerId: worker.userId }, 'Failed to explain match');
      return {
        success: false,
        error: {
          code: 'EXPLAIN_MATCH_FAILED',
          message: error instanceof Error ? error.message : 'Failed to explain match',
        },
      };
    }
  },

  /**
   * Suggest a price for a task based on description, category, and location.
   *
   * Different from ScoperAI - this is lightweight and instant for the UI price hint.
   * Uses heuristics first; only calls AI if heuristic confidence is low.
   *
   * @returns Price suggestion with range and reasoning
   */
  suggestPrice: async (
    taskDescription: string,
    category?: string,
    location?: string
  ): Promise<ServiceResult<PriceSuggestion>> => {
    try {
      // Step 1: Try heuristic pricing first
      const heuristic = MatchmakerAIService._heuristicPrice(taskDescription, category, location);

      // Step 2: If heuristic confidence is high enough, return immediately
      if (heuristic.confidence >= HEURISTIC_CONFIDENCE_THRESHOLD) {
        // Log decision
        await MatchmakerAIService._logDecision(
          null,
          { type: 'suggest_price', method: 'heuristic', category, description: taskDescription.slice(0, 100) },
          heuristic.confidence,
          heuristic.reasoning
        );

        return { success: true, data: heuristic };
      }

      // Step 3: Low confidence heuristic - try AI enhancement
      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<{
            suggested_price_cents: number;
            range_low_cents: number;
            range_high_cents: number;
            reasoning: string;
            confidence: number;
          }>({
            route: 'fast',
            temperature: 0.3,
            timeoutMs: 5000,
            maxTokens: 256,
            systemPrompt: `You are HustleXP's price suggestion engine. Provide instant price estimates for local tasks.

BOUNDS:
- Minimum: $15 (1500 cents), Maximum: $500 (50000 cents)
- Range spread: typically +-20-30% of suggested price
- Confidence: 0.0-1.0

CATEGORY BENCHMARKS (approximate):
- Delivery/errands: $20-$40
- Cleaning: $30-$60
- Moving/furniture: $60-$120
- Handyman/repair: $80-$200
- Tutoring: $40-$80
- Pet care: $25-$50

Return JSON: { "suggested_price_cents": number, "range_low_cents": number, "range_high_cents": number, "reasoning": string, "confidence": number }`,
            prompt: `Task: ${taskDescription}
Category: ${category || 'unknown'}
Location: ${location || 'not specified'}`,
          });

          const suggestion: PriceSuggestion = {
            suggested_price_cents: Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, aiResult.data.suggested_price_cents)),
            range_low_cents: Math.max(MIN_PRICE_CENTS, aiResult.data.range_low_cents),
            range_high_cents: Math.min(MAX_PRICE_CENTS, aiResult.data.range_high_cents),
            reasoning: aiResult.data.reasoning,
            confidence: Math.max(0, Math.min(1, aiResult.data.confidence)),
          };

          log.info({ suggestedPriceCents: suggestion.suggested_price_cents, provider: aiResult.provider, category }, 'AI price suggestion generated');

          // Log decision
          await MatchmakerAIService._logDecision(
            null,
            { type: 'suggest_price', method: 'ai', category, description: taskDescription.slice(0, 100) },
            suggestion.confidence,
            suggestion.reasoning
          );

          return { success: true, data: suggestion };
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? (aiError as Error).message : String(aiError), category }, 'AI price suggestion failed, returning heuristic');
        }
      }

      // Fallback: return heuristic result even if low confidence
      await MatchmakerAIService._logDecision(
        null,
        { type: 'suggest_price', method: 'heuristic_fallback', category, description: taskDescription.slice(0, 100) },
        heuristic.confidence,
        heuristic.reasoning
      );

      return { success: true, data: heuristic };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), category }, 'Failed to suggest price');
      return {
        success: false,
        error: {
          code: 'SUGGEST_PRICE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to suggest price',
        },
      };
    }
  },

  // ==========================================================================
  // DETERMINISTIC FALLBACKS
  // ==========================================================================

  /**
   * Deterministic candidate ranking when AI is unavailable.
   * Uses weighted scoring formula.
   */
  _rankDeterministic: (task: TaskInput, candidates: CandidateInput[]): MatchCandidate[] => {
    const scored = candidates.map((c) => {
      // Skill match: check keyword overlap between task description and candidate skills
      const taskWords = `${task.title} ${task.description} ${task.category || ''}`.toLowerCase().split(/\s+/);
      const candidateSkills = (c.skills || []).map((s) => s.toLowerCase());
      const skillOverlap = candidateSkills.length > 0
        ? candidateSkills.filter((skill) => taskWords.some((word) => skill.includes(word) || word.includes(skill))).length / candidateSkills.length
        : 0.5; // No skills listed: neutral score

      // Proximity: default 0.5 if unknown
      const proximity = c.location ? 0.7 : 0.5;

      // Reliability: based on completion rate and task count
      const taskCountFactor = Math.min(1, c.completedTasks / 20); // Maxes out at 20 tasks
      const reliability = c.completionRate * 0.7 + taskCountFactor * 0.3;

      // Trust tier: normalized (tier 1-4 -> 0.25-1.0)
      const trustScore = c.trustTier / 4;

      // Availability
      const availability = c.isAvailable ? 1.0 : 0.0;

      // Weighted score
      const matchScore =
        skillOverlap * 0.30 +
        proximity * 0.20 +
        reliability * 0.25 +
        trustScore * 0.15 +
        availability * 0.10;

      return {
        userId: c.userId,
        matchScore,
        factors: {
          skillMatch: Math.round(skillOverlap * 100) / 100,
          proximity: Math.round(proximity * 100) / 100,
          reliability: Math.round(reliability * 100) / 100,
          trustTier: Math.round(trustScore * 100) / 100,
          availability,
        },
      };
    });

    // Sort by score descending, filter >= 0.30, take top 10
    return scored
      .filter((s) => s.matchScore >= 0.30)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, MAX_RANKED_CANDIDATES)
      .map((s, idx) => ({
        userId: s.userId,
        rank: idx + 1,
        matchScore: Math.round(s.matchScore * 100) / 100,
        reasoning: `Deterministic match: skill=${(s.factors.skillMatch * 100).toFixed(0)}%, reliability=${(s.factors.reliability * 100).toFixed(0)}%, trust tier ${Math.round(s.factors.trustTier * 4)}/4`,
        factors: s.factors,
      }));
  },

  /**
   * Deterministic match explanation when AI is unavailable.
   */
  _explainDeterministic: (task: TaskInput, worker: CandidateInput): MatchExplanation => {
    const earnings = Math.round(task.price * 0.85); // 15% platform fee
    const durationMinutes = Math.round((task.price / 100) * 2.5); // ~$40/hr rate estimate

    const factors: string[] = [];

    if (worker.skills && worker.skills.length > 0) {
      factors.push(`Your skills in ${worker.skills.slice(0, 2).join(' and ')} align with this task`);
    }
    if (worker.completionRate >= 0.90) {
      factors.push(`Your ${(worker.completionRate * 100).toFixed(0)}% completion rate makes you a reliable match`);
    }
    if (worker.trustTier >= 3) {
      factors.push(`Trust tier ${worker.trustTier}/4 gives you priority access`);
    }
    factors.push(`Estimated earnings: $${(earnings / 100).toFixed(2)} after platform fee`);

    let durationStr: string;
    if (durationMinutes < 60) {
      durationStr = `${durationMinutes}-${durationMinutes + 15} min`;
    } else {
      const hours = Math.floor(durationMinutes / 60);
      const remainder = durationMinutes % 60;
      durationStr = remainder > 0 ? `${hours}-${hours + 1} hours` : `~${hours} hour${hours > 1 ? 's' : ''}`;
    }

    const summary = `This ${task.category || 'task'} is a good fit based on your profile and past performance. You could earn $${(earnings / 100).toFixed(2)} in about ${durationStr}.`;

    return {
      summary,
      factors,
      estimatedEarnings: earnings,
      estimatedDuration: durationStr,
    };
  },

  /**
   * Heuristic price suggestion based on keywords and category.
   */
  _heuristicPrice: (
    taskDescription: string,
    category?: string,
    _location?: string
  ): PriceSuggestion => {
    const description = taskDescription.toLowerCase();
    let baseCents = CATEGORY_BASE_PRICES[category || ''] || CATEGORY_BASE_PRICES.general;
    let confidence = 0.65;
    const reasons: string[] = [];

    // Category-based pricing
    if (category && CATEGORY_BASE_PRICES[category]) {
      confidence += 0.10;
      reasons.push(`Category "${category}" base rate`);
    }

    // Keyword adjustments
    if (description.includes('urgent') || description.includes('asap') || description.includes('rush')) {
      baseCents = Math.round(baseCents * 1.4);
      reasons.push('urgency premium +40%');
    }
    if (description.includes('heavy') || description.includes('furniture') || description.includes('appliance')) {
      baseCents = Math.round(baseCents * 1.3);
      reasons.push('heavy lifting premium +30%');
    }
    if (description.includes('multiple') || description.includes('several') || description.includes('all day')) {
      baseCents = Math.round(baseCents * 1.5);
      reasons.push('extended scope premium +50%');
    }

    // Description length affects confidence
    if (description.length >= 100) {
      confidence += 0.10;
    } else if (description.length < 30) {
      confidence -= 0.15;
      reasons.push('short description, lower confidence');
    }

    // Clamp to bounds
    baseCents = Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, baseCents));
    confidence = Math.max(0.30, Math.min(1.0, confidence));

    // Generate range (+-25%)
    const rangeLow = Math.max(MIN_PRICE_CENTS, Math.round(baseCents * 0.75));
    const rangeHigh = Math.min(MAX_PRICE_CENTS, Math.round(baseCents * 1.25));

    return {
      suggested_price_cents: baseCents,
      range_low_cents: rangeLow,
      range_high_cents: rangeHigh,
      reasoning: reasons.length > 0
        ? `Price based on: ${reasons.join(', ')}`
        : `Standard rate for ${category || 'general'} tasks in this area`,
      confidence,
    };
  },

  // ==========================================================================
  // LOGGING
  // ==========================================================================

  /**
   * Log Matchmaker decision to ai_agent_decisions table.
   *
   * NOTE: Requires ALTER TABLE ai_agent_decisions
   *   DROP CONSTRAINT IF EXISTS ai_agent_decisions_agent_type_check,
   *   ADD CONSTRAINT ai_agent_decisions_agent_type_check
   *     CHECK (agent_type IN ('scoper', 'logistics', 'judge', 'matchmaker'));
   *
   * If the migration has not been applied, insert will fail gracefully
   * and log a warning without breaking the caller.
   */
  _logDecision: async (
    taskId: string | null,
    proposal: Record<string, unknown>,
    confidenceScore: number,
    reasoning: string
  ): Promise<void> => {
    try {
      await db.query(
        `INSERT INTO ai_agent_decisions (
          agent_type, task_id, proposal, confidence_score, reasoning,
          accepted, validator_override, authority_level
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'matchmaker',
          taskId,
          JSON.stringify(proposal),
          confidenceScore,
          reasoning,
          null, // Pending review (A2 authority: proposal-only)
          false,
          'A2',
        ]
      );
    } catch (error) {
      // Non-fatal: logging failure should not break matchmaking
      log.warn({ err: error instanceof Error ? error.message : String(error), taskId }, 'Failed to log matchmaker decision (CHECK constraint migration may be needed)');
    }
  },
};

export default MatchmakerAIService;
