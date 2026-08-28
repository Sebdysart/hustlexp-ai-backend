/**
 * AI Response Schemas Unit Tests
 *
 * Tests Zod schemas that validate AI model outputs at runtime,
 * preventing malformed responses from propagating through the system.
 *
 * @see backend/src/lib/ai-response-schemas.ts
 */
import { describe, it, expect } from 'vitest';
import {
  JudgeVerdictSchema,
  MatchmakerRankingsSchema,
  MatchExplanationSchema,
  PriceSuggestionSchema,
  DisputeAnalysisSchema,
  EvidenceRequestSchema,
  ScoperProposalSchema,
} from '../../src/lib/ai-response-schemas';

// ============================================================================
// JudgeVerdictSchema
// ============================================================================

describe('JudgeVerdictSchema', () => {
  const validVerdict = {
    verdict: 'APPROVE',
    confidence: 0.95,
    reasoning: 'All verification signals passed with high confidence scores',
    risk_score: 0.05,
    component_scores: {
      biometric: 0.1,
      logistics: 0.05,
      photo_verification: 0.0,
    },
    fraud_flags: [],
    recommended_action: 'Auto-approve and release escrow',
  };

  it('accepts valid APPROVE verdict', () => {
    const result = JudgeVerdictSchema.safeParse(validVerdict);
    expect(result.success).toBe(true);
  });

  it('accepts MANUAL_REVIEW verdict', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      verdict: 'MANUAL_REVIEW',
    });
    expect(result.success).toBe(true);
  });

  it('accepts REJECT verdict', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      verdict: 'REJECT',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid verdict value', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      verdict: 'MAYBE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence > 1', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence < 0', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing reasoning', () => {
    const { reasoning: _, ...noReasoning } = validVerdict;
    const result = JudgeVerdictSchema.safeParse(noReasoning);
    expect(result.success).toBe(false);
  });

  it('rejects missing component_scores', () => {
    const { component_scores: _, ...noScores } = validVerdict;
    const result = JudgeVerdictSchema.safeParse(noScores);
    expect(result.success).toBe(false);
  });

  it('accepts -1 component scores (unavailable domains)', () => {
    const result = JudgeVerdictSchema.safeParse({
      ...validVerdict,
      component_scores: {
        biometric: -1,
        logistics: 0.05,
        photo_verification: -1,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// MatchmakerRankingsSchema
// ============================================================================

describe('MatchmakerRankingsSchema', () => {
  const validRankingItem = {
    index: 0,
    matchScore: 0.85,
    reasoning: 'Strong match based on skills and proximity',
    factors: {
      skillMatch: 0.9,
      proximity: 0.8,
      reliability: 0.95,
      trustTier: 0.7,
      availability: 1.0,
    },
  };

  const validRankings = {
    rankings: [
      validRankingItem,
      {
        ...validRankingItem,
        index: 1,
        matchScore: 0.72,
        reasoning: 'Good category match but farther distance',
      },
    ],
  };

  it('accepts valid rankings', () => {
    const result = MatchmakerRankingsSchema.safeParse(validRankings);
    expect(result.success).toBe(true);
  });

  it('rejects matchScore > 1', () => {
    const result = MatchmakerRankingsSchema.safeParse({
      rankings: [{
        ...validRankingItem,
        matchScore: 1.5,
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects matchScore < 0', () => {
    const result = MatchmakerRankingsSchema.safeParse({
      rankings: [{
        ...validRankingItem,
        matchScore: -0.1,
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing factors', () => {
    const { factors: _, ...noFactors } = validRankingItem;
    const result = MatchmakerRankingsSchema.safeParse({
      rankings: [noFactors],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty rankings array', () => {
    const result = MatchmakerRankingsSchema.safeParse({ rankings: [] });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// DisputeAnalysisSchema
// ============================================================================

describe('DisputeAnalysisSchema', () => {
  const validAnalysis = {
    summary: 'Worker did not complete the task as described',
    fault_assessment: {
      poster_fault_score: 0.1,
      worker_fault_score: 0.8,
      unclear_score: 0.1,
    },
    recommended_action: 'REFUND',
    reasoning: 'Task was not completed to specification based on evidence',
    confidence: 0.85,
    precedent_signals: ['incomplete_work'],
    escalation_recommended: false,
  };

  it('accepts valid analysis with REFUND', () => {
    const result = DisputeAnalysisSchema.safeParse(validAnalysis);
    expect(result.success).toBe(true);
  });

  it('accepts RELEASE recommendation', () => {
    const result = DisputeAnalysisSchema.safeParse({
      ...validAnalysis,
      recommended_action: 'RELEASE',
    });
    expect(result.success).toBe(true);
  });

  it('accepts SPLIT recommendation with ratio', () => {
    const result = DisputeAnalysisSchema.safeParse({
      ...validAnalysis,
      recommended_action: 'SPLIT',
      split_ratio: { worker_pct: 60, poster_pct: 40 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid recommendation', () => {
    const result = DisputeAnalysisSchema.safeParse({
      ...validAnalysis,
      recommended_action: 'IGNORE',
    });
    expect(result.success).toBe(false);
  });

  it('allows optional split_ratio', () => {
    const result = DisputeAnalysisSchema.safeParse(validAnalysis);
    expect(result.success).toBe(true);
  });

  it('rejects missing reasoning', () => {
    const { reasoning: _, ...noReasoning } = validAnalysis;
    const result = DisputeAnalysisSchema.safeParse(noReasoning);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ScoperProposalSchema
// ============================================================================

describe('ScoperProposalSchema', () => {
  const validProposal = {
    suggested_price_cents: 5000,
    price_reasoning: 'Standard rate for delivery task in metro area',
    suggested_xp: 500,
    xp_reasoning: 'XP based on price tier',
    difficulty: 'medium',
    difficulty_reasoning: 'Moderate complexity for delivery',
    confidence_score: 0.85,
    flags: ['vehicle_required'],
  };

  it('accepts valid proposal', () => {
    const result = ScoperProposalSchema.safeParse(validProposal);
    expect(result.success).toBe(true);
  });

  it('accepts easy difficulty', () => {
    const result = ScoperProposalSchema.safeParse({
      ...validProposal,
      difficulty: 'easy',
    });
    expect(result.success).toBe(true);
  });

  it('accepts hard difficulty', () => {
    const result = ScoperProposalSchema.safeParse({
      ...validProposal,
      difficulty: 'hard',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid difficulty', () => {
    const result = ScoperProposalSchema.safeParse({
      ...validProposal,
      difficulty: 'extreme',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = ScoperProposalSchema.safeParse({
      ...validProposal,
      estimated_duration_minutes: 45,
      required_capabilities: ['vehicle', 'tools'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative price', () => {
    const result = ScoperProposalSchema.safeParse({
      ...validProposal,
      suggested_price_cents: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = ScoperProposalSchema.safeParse({
      suggested_price_cents: 5000,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// MatchExplanationSchema
// ============================================================================

describe('MatchExplanationSchema', () => {
  it('accepts valid explanation', () => {
    const result = MatchExplanationSchema.safeParse({
      summary: 'This hustler has experience with delivery tasks in your area',
      factors: ['proximity', 'category_experience'],
      estimatedEarnings: 3500,
      estimatedDuration: '45 minutes',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing summary', () => {
    const result = MatchExplanationSchema.safeParse({
      factors: ['test'],
      estimatedEarnings: 3500,
      estimatedDuration: '30 minutes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing estimatedDuration', () => {
    const result = MatchExplanationSchema.safeParse({
      summary: 'Good match',
      factors: ['proximity'],
      estimatedEarnings: 3500,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// PriceSuggestionSchema
// ============================================================================

describe('PriceSuggestionSchema', () => {
  it('accepts valid price suggestion', () => {
    const result = PriceSuggestionSchema.safeParse({
      suggested_price_cents: 3500,
      range_low_cents: 2500,
      range_high_cents: 5000,
      reasoning: 'Market rate for this type of task',
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing reasoning', () => {
    const result = PriceSuggestionSchema.safeParse({
      suggested_price_cents: 3500,
      range_low_cents: 2500,
      range_high_cents: 5000,
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing range fields', () => {
    const result = PriceSuggestionSchema.safeParse({
      suggested_price_cents: 3500,
      reasoning: 'Market rate',
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// EvidenceRequestSchema
// ============================================================================

describe('EvidenceRequestSchema', () => {
  it('accepts valid evidence request', () => {
    const result = EvidenceRequestSchema.safeParse({
      poster_questions: ['Can you provide photos of the completed work?'],
      worker_questions: ['Did the poster provide accurate task details?'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing poster_questions', () => {
    const result = EvidenceRequestSchema.safeParse({
      worker_questions: ['Did you complete all steps?'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing worker_questions', () => {
    const result = EvidenceRequestSchema.safeParse({
      poster_questions: ['Can you provide photos?'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty question arrays', () => {
    const result = EvidenceRequestSchema.safeParse({
      poster_questions: [],
      worker_questions: ['Did you finish?'],
    });
    expect(result.success).toBe(false);
  });
});
