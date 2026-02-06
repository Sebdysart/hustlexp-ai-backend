/**
 * ScoperAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Analyzes task descriptions and proposes pricing, XP rewards, and difficulty ratings.
 * Cannot directly set task.price or task.xp_reward - proposals validated by deterministic rules.
 *
 * @see SCOPER_AGENT_SPEC_LOCKED.md
 * @see schema.sql v1.8.0 (ai_agent_decisions)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

type Difficulty = 'easy' | 'medium' | 'hard';

interface ScoperInput {
  description: string;
  category?: string;
  budget_hint_cents?: number;
  location?: {
    city: string;
    state: string;
    zip_code?: string;
  };
}

interface ScoperProposal {
  suggested_price_cents: number; // $15-$500 (1500-50000 cents)
  price_reasoning: string;
  suggested_xp: number;
  xp_reasoning: string;
  difficulty: Difficulty;
  difficulty_reasoning: string;
  confidence_score: number; // 0.0-1.0
  flags: string[];
  estimated_duration_minutes?: number;
  required_capabilities?: string[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// CONSTITUTIONAL BOUNDS
// ============================================================================

const MIN_PRICE_CENTS = 1500; // $15 minimum
const MAX_PRICE_CENTS = 50000; // $500 maximum
const XP_TOLERANCE_PERCENTAGE = 0.20; // ±20% from price/10 formula
const MIN_CONFIDENCE_THRESHOLD = 0.60; // Below this requires human review

const DIFFICULTY_PRICE_RANGES = {
  easy: { min: 1500, max: 5000 }, // $15-$50
  medium: { min: 5000, max: 15000 }, // $50-$150
  hard: { min: 15000, max: 50000 } // $150-$500
};

// ============================================================================
// SERVICE
// ============================================================================

export const ScoperAIService = {
  /**
   * Analyze task scope and generate pricing/XP proposal
   * Uses LLM for analysis, deterministic validator for acceptance
   */
  analyzeTaskScope: async (input: ScoperInput): Promise<ServiceResult<ScoperProposal>> => {
    try {
      // TODO: Call LLM (GPT-4o, Claude 3.5) with prompt from SCOPER_AGENT_SPEC_LOCKED.md
      // For now, use heuristic-based estimation

      const proposal = ScoperAIService._generateProposal(input);

      // Validate proposal against constitutional rules
      const validation = ScoperAIService._validateProposal(proposal);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            code: 'PROPOSAL_VALIDATION_FAILED',
            message: `Proposal validation failed: ${validation.errors.join(', ')}`
          }
        };
      }

      return { success: true, data: proposal };
    } catch (error) {
      console.error('[ScoperAIService.analyzeTaskScope] Error:', error);
      return {
        success: false,
        error: {
          code: 'TASK_ANALYSIS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to analyze task'
        }
      };
    }
  },

  /**
   * Refine task description (remove slop, standardize format)
   */
  refineTaskDescription: (rawDescription: string): string => {
    // TODO: Use LLM to clean and structure description
    // For now, basic cleanup
    return rawDescription.trim().replace(/\s+/g, ' ').slice(0, 500);
  },

  /**
   * Validate Scoper proposal against constitutional rules
   */
  validateScopeProposal: (proposal: ScoperProposal): ValidationResult => {
    return ScoperAIService._validateProposal(proposal);
  },

  /**
   * Log Scoper decision to ai_agent_decisions table
   */
  logDecision: async (
    taskId: string,
    proposal: ScoperProposal,
    accepted: boolean,
    validatorReason?: string
  ): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `INSERT INTO ai_agent_decisions (
          agent_type, task_id, proposal, confidence_score, reasoning,
          accepted, validator_override, validator_reason, authority_level
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          'scoper',
          taskId,
          JSON.stringify(proposal),
          proposal.confidence_score,
          proposal.price_reasoning,
          accepted,
          false,
          validatorReason,
          'A2'
        ]
      );

      return { success: true, data: undefined };
    } catch (error) {
      console.error('[ScoperAIService.logDecision] Error:', error);
      return {
        success: false,
        error: {
          code: 'LOG_DECISION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to log decision'
        }
      };
    }
  },

  /**
   * Private: Generate proposal using heuristics
   * TODO: Replace with LLM-based generation
   */
  _generateProposal: (input: ScoperInput): ScoperProposal => {
    const description = input.description.toLowerCase();

    // Simple heuristic pricing based on keywords
    let priceCents = 3000; // Default $30
    let difficulty: Difficulty = 'medium';
    const flags: string[] = [];
    const requiredCapabilities: string[] = [];

    // Keyword-based adjustments
    if (description.includes('delivery') || description.includes('pickup')) {
      priceCents = 2500;
      difficulty = 'easy';
      requiredCapabilities.push('vehicle');
    } else if (description.includes('moving') || description.includes('furniture')) {
      priceCents = 8000;
      difficulty = 'medium';
      requiredCapabilities.push('vehicle', 'strength');
      flags.push('heavy_lifting');
    } else if (description.includes('clean') || description.includes('organize')) {
      priceCents = 4000;
      difficulty = 'easy';
    } else if (description.includes('handyman') || description.includes('repair')) {
      priceCents = 10000;
      difficulty = 'hard';
      requiredCapabilities.push('tools', 'skills');
      flags.push('specialized_skill');
    } else if (description.includes('urgent') || description.includes('asap')) {
      priceCents *= 1.5; // 50% urgency premium
      flags.push('urgent');
    }

    // Budget hint adjustment
    if (input.budget_hint_cents) {
      priceCents = Math.round((priceCents + input.budget_hint_cents) / 2);
    }

    // Ensure bounds
    priceCents = Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, priceCents));

    // Calculate XP (100 XP per $1)
    const suggestedXp = Math.round(priceCents / 10);

    // Adjust difficulty to match price tier
    if (priceCents <= DIFFICULTY_PRICE_RANGES.easy.max) {
      difficulty = 'easy';
    } else if (priceCents <= DIFFICULTY_PRICE_RANGES.medium.max) {
      difficulty = 'medium';
    } else {
      difficulty = 'hard';
    }

    // Estimate duration
    const estimatedDurationMinutes = Math.round((priceCents / 100) * 2.5); // $40/hr rate

    // Confidence based on description quality
    let confidence = 0.75;
    if (description.length < 20) {
      confidence = 0.50; // Low confidence for short descriptions
      flags.push('ambiguous_description');
    } else if (description.length > 100) {
      confidence = 0.90; // High confidence for detailed descriptions
    }

    return {
      suggested_price_cents: priceCents,
      price_reasoning: `Based on task category (${input.category || 'general'}), estimated effort, and market rates. ${flags.includes('urgent') ? 'Includes 50% urgency premium.' : ''}`,
      suggested_xp: suggestedXp,
      xp_reasoning: `Base XP: ${suggestedXp} (100 XP per dollar earned)`,
      difficulty,
      difficulty_reasoning: `Task complexity and required skills match ${difficulty} tier (${priceCents <= 5000 ? '<$50' : priceCents <= 15000 ? '$50-$150' : '$150+'})`,
      confidence_score: confidence,
      flags,
      estimated_duration_minutes: estimatedDurationMinutes,
      required_capabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined
    };
  },

  /**
   * Private: Validate proposal against constitutional rules
   */
  _validateProposal: (proposal: ScoperProposal): ValidationResult => {
    const errors: string[] = [];

    // Rule 1: Price bounds ($15-$500)
    if (proposal.suggested_price_cents < MIN_PRICE_CENTS) {
      errors.push(`SCOPER-ERR-001: Price $${(proposal.suggested_price_cents / 100).toFixed(2)} below minimum $15`);
    }
    if (proposal.suggested_price_cents > MAX_PRICE_CENTS) {
      errors.push(`SCOPER-ERR-002: Price $${(proposal.suggested_price_cents / 100).toFixed(2)} above maximum $500`);
    }

    // Rule 2: XP calculation (price/10 ±20%)
    const expectedXp = Math.round(proposal.suggested_price_cents / 10);
    const xpTolerance = expectedXp * XP_TOLERANCE_PERCENTAGE;
    if (Math.abs(proposal.suggested_xp - expectedXp) > xpTolerance) {
      errors.push(`SCOPER-ERR-003: XP ${proposal.suggested_xp} deviates >20% from expected ${expectedXp}`);
    }

    // Rule 3: Difficulty-price alignment
    const range = DIFFICULTY_PRICE_RANGES[proposal.difficulty];
    if (proposal.suggested_price_cents < range.min || proposal.suggested_price_cents > range.max) {
      // Auto-correct difficulty instead of failing
      if (proposal.suggested_price_cents <= DIFFICULTY_PRICE_RANGES.easy.max) {
        proposal.difficulty = 'easy';
      } else if (proposal.suggested_price_cents <= DIFFICULTY_PRICE_RANGES.medium.max) {
        proposal.difficulty = 'medium';
      } else {
        proposal.difficulty = 'hard';
      }
    }

    // Rule 4: Confidence threshold
    if (proposal.confidence_score < MIN_CONFIDENCE_THRESHOLD) {
      errors.push(`SCOPER-ERR-004: Confidence ${(proposal.confidence_score * 100).toFixed(0)}% too low, requires human review`);
    }

    // Rule 5: Reasoning required
    if (!proposal.price_reasoning || proposal.price_reasoning.length < 20) {
      errors.push('SCOPER-ERR-005: Missing or insufficient price reasoning');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
};
