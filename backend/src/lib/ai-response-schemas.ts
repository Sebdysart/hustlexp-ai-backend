/**
 * AI Response Schemas v1.0.0
 *
 * Zod schemas for validating AI model outputs at runtime.
 * Prevents malformed AI responses from propagating through the system.
 *
 * Used by AIClient.callJSON({ schema: ... }) for runtime validation.
 *
 * @see AIClient.ts (callJSON)
 * @see JudgeAIService.ts, MatchmakerAIService.ts, DisputeAIService.ts, ScoperAIService.ts
 */

import { z } from 'zod';

// ============================================================================
// JUDGE AI — Verdict Schema
// ============================================================================

export const JudgeVerdictSchema = z.object({
  verdict: z.enum(['APPROVE', 'MANUAL_REVIEW', 'REJECT']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  risk_score: z.number().min(0).max(1),
  component_scores: z.object({
    biometric: z.number(),
    logistics: z.number(),
    photo_verification: z.number(),
  }),
  fraud_flags: z.array(z.string()),
  recommended_action: z.string().min(1),
});

export type JudgeVerdictParsed = z.infer<typeof JudgeVerdictSchema>;

// ============================================================================
// MATCHMAKER AI — Rankings Schema
// ============================================================================

export const MatchmakerRankingItemSchema = z.object({
  index: z.number().int().min(0),
  matchScore: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  factors: z.object({
    skillMatch: z.number().min(0).max(1),
    proximity: z.number().min(0).max(1),
    reliability: z.number().min(0).max(1),
    trustTier: z.number().min(0).max(1),
    availability: z.number().min(0).max(1),
  }),
});

export const MatchmakerRankingsSchema = z.object({
  rankings: z.array(MatchmakerRankingItemSchema),
});

export type MatchmakerRankingsParsed = z.infer<typeof MatchmakerRankingsSchema>;

// ============================================================================
// MATCHMAKER AI — Explanation Schema
// ============================================================================

export const MatchExplanationSchema = z.object({
  summary: z.string().min(1),
  factors: z.array(z.string()),
  estimatedEarnings: z.number().min(0),
  estimatedDuration: z.string().min(1),
});

export type MatchExplanationParsed = z.infer<typeof MatchExplanationSchema>;

// ============================================================================
// MATCHMAKER AI — Price Suggestion Schema
// ============================================================================

export const PriceSuggestionSchema = z.object({
  suggested_price_cents: z.number().int().min(0),
  range_low_cents: z.number().int().min(0),
  range_high_cents: z.number().int().min(0),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type PriceSuggestionParsed = z.infer<typeof PriceSuggestionSchema>;

// ============================================================================
// DISPUTE AI — Analysis Schema
// ============================================================================

export const DisputeAnalysisSchema = z.object({
  summary: z.string().min(1),
  fault_assessment: z.object({
    poster_fault_score: z.number().min(0).max(1),
    worker_fault_score: z.number().min(0).max(1),
    unclear_score: z.number().min(0).max(1),
  }),
  recommended_action: z.enum(['RELEASE', 'REFUND', 'SPLIT']),
  split_ratio: z.object({
    worker_pct: z.number().min(0).max(100),
    poster_pct: z.number().min(0).max(100),
  }).optional(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
  precedent_signals: z.array(z.string()),
  escalation_recommended: z.boolean(),
});

export type DisputeAnalysisParsed = z.infer<typeof DisputeAnalysisSchema>;

// ============================================================================
// DISPUTE AI — Evidence Request Schema
// ============================================================================

export const EvidenceRequestSchema = z.object({
  poster_questions: z.array(z.string().min(1)).min(1),
  worker_questions: z.array(z.string().min(1)).min(1),
});

export type EvidenceRequestParsed = z.infer<typeof EvidenceRequestSchema>;

// ============================================================================
// SCOPER AI — Proposal Schema
// ============================================================================

export const ScoperProposalSchema = z.object({
  suggested_price_cents: z.number().int().min(0),
  price_reasoning: z.string().min(1),
  suggested_xp: z.number().int().min(0),
  xp_reasoning: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  difficulty_reasoning: z.string().min(1),
  confidence_score: z.number().min(0).max(1),
  flags: z.array(z.string()),
  estimated_duration_minutes: z.number().int().min(0).optional(),
  required_capabilities: z.array(z.string()).optional(),
});

export type ScoperProposalParsed = z.infer<typeof ScoperProposalSchema>;
