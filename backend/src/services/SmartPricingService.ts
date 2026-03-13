/**
 * SmartPricingService — unified smart pricing for task creation
 *
 * Orchestrates:
 * 1. Base price suggestion (AI/heuristic) from task title, description, category, location
 * 2. Dynamic factors (surge, time-of-day, ASAP premium, worker modifier)
 *
 * Returns a single recommended price with breakdown and reasoning for the poster.
 *
 * @see MatchmakerAIService.suggestPrice
 * @see DynamicPricingService.calculatePrice
 */

import type { ServiceResult } from '../types.js';
import { MatchmakerAIService } from './MatchmakerAIService.js';
import { DynamicPricingService } from './DynamicPricingService.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SmartPricingInput {
  title: string;
  description: string;
  category?: string;
  /** Location string (e.g. address or city) for AI context */
  location?: string;
  /** Lat/lng for surge/demand calculation */
  locationLat?: number;
  locationLng?: number;
  mode?: 'STANDARD' | 'LIVE';
  isASAP?: boolean;
  /** If provided, worker modifier is applied (e.g. when previewing as a worker) */
  workerId?: string;
}

export interface SmartPricingResult {
  /** Base suggestion from AI/heuristic (before dynamic factors) */
  base_suggestion_cents: number;
  range_low_cents: number;
  range_high_cents: number;
  /** Human-readable reasoning for the base price */
  base_reasoning: string;
  /** Confidence of base suggestion (0–1) */
  confidence: number;

  /** Dynamic adjustments applied */
  surge_multiplier: number;
  surge_reason: string | null;
  urgency_premium_cents: number;
  worker_modifier_cents: number;

  /** Final recommended price (base × surge + urgency + worker modifier), min $5 */
  recommended_price_cents: number;
  /** Breakdown for UI */
  breakdown: {
    base: number;
    surge: number;
    urgency: number;
    worker_modifier: number;
    total: number;
  };
  /** Short summary for UI, e.g. "Based on category and demand in your area" */
  summary: string;
}

// ============================================================================
// SERVICE
// ============================================================================

const MIN_FINAL_CENTS = 500; // $5 minimum

export const SmartPricingService = {
  /**
   * Get a smart price recommendation for a task.
   * Combines AI/heuristic base suggestion with dynamic (surge, ASAP, worker) factors.
   */
  getSmartPrice: async (input: SmartPricingInput): Promise<ServiceResult<SmartPricingResult>> => {
    const mode = input.mode ?? 'STANDARD';
    const isASAP = input.isASAP ?? false;

    try {
      // 1. Base price suggestion from task content (AI or heuristic)
      const taskDescription = `${input.title}${input.description ? ` - ${input.description}` : ''}`;
      const suggestResult = await MatchmakerAIService.suggestPrice(
        taskDescription,
        input.category,
        input.location
      );

      if (!suggestResult.success) {
        return suggestResult;
      }

      const base = suggestResult.data;
      const baseCents = base.suggested_price_cents;

      // 2. Apply dynamic pricing (surge, time-of-day, ASAP, worker modifier)
      const dynamicResult = await DynamicPricingService.calculatePrice({
        basePriceCents: baseCents,
        mode,
        category: input.category,
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        isASAP,
        workerId: input.workerId,
      });

      if (!dynamicResult.success) {
        return dynamicResult;
      }

      const dyn = dynamicResult.data;
      const finalCents = Math.max(MIN_FINAL_CENTS, dyn.final_price_cents);

      // 3. Build summary string
      const parts: string[] = [base.reasoning];
      if (dyn.surge_reason) parts.push(dyn.surge_reason);
      if (dyn.urgency_premium_cents > 0) parts.push('ASAP/Live premium applied.');
      if (dyn.worker_modifier_cents !== 0) parts.push('Worker rate modifier applied.');

      return {
        success: true,
        data: {
          base_suggestion_cents: baseCents,
          range_low_cents: base.range_low_cents,
          range_high_cents: base.range_high_cents,
          base_reasoning: base.reasoning,
          confidence: base.confidence,
          surge_multiplier: dyn.surge_multiplier,
          surge_reason: dyn.surge_reason,
          urgency_premium_cents: dyn.urgency_premium_cents,
          worker_modifier_cents: dyn.worker_modifier_cents,
          recommended_price_cents: finalCents,
          breakdown: dyn.breakdown,
          summary: parts.join(' ').slice(0, 500),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SMART_PRICING_ERROR',
          message: error instanceof Error ? error.message : 'Smart pricing failed',
        },
      };
    }
  },
};

export default SmartPricingService;
