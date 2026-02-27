/**
 * TaskBatchingService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * AI-powered route optimization for task batching.
 * Proposes optimal task combinations to maximize earnings per hour.
 * All proposals validated by deterministic efficiency thresholds.
 *
 * @see AI_INFRASTRUCTURE.md §3.7
 */

import type { ServiceResult } from '../types';
import { AIClient } from './AIClient';
import { aiLogger } from '../logger';
import { z } from 'zod';

const log = aiLogger.child({ service: 'TaskBatchingService' });

// ============================================================================
// TYPES
// ============================================================================

interface Task {
  id: string;
  title: string;
  price: number; // cents
  location: string;
  latitude?: number;
  longitude?: number;
  estimatedDuration?: number; // minutes
}

interface BatchRecommendation {
  primaryTask: Task;
  additionalTasks: Task[];
  totalEarnings: number; // cents
  totalDuration: number; // minutes
  earningsPerHour: number; // dollars/hour
  routeDistance: number; // meters
  estimatedTravelTime: number; // minutes
  savingsVsIndividual: number; // cents
  confidence: number; // 0-1
  reasoning: string;
}

interface BatchSavings {
  totalEarnings: number;
  combinedDuration: number;
  individualDuration: number;
  timeSaved: number;
  earningsBoost: number;
}

// ============================================================================
// CONSTITUTIONAL BOUNDS
// ============================================================================

const MIN_EARNINGS_PER_HOUR = 2000; // $20/hr minimum (constitutional floor)
const MAX_BATCH_SIZE = 5; // Maximum tasks in one batch
const MAX_ROUTE_DISTANCE = 5000; // 5km maximum total route distance
const MIN_CONFIDENCE_THRESHOLD = 0.65; // Below this requires manual review

// ============================================================================
// SERVICE
// ============================================================================

export const TaskBatchingService = {
  /**
   * Generate batch recommendation for a worker
   */
  generateRecommendation: async (
    workerId: string,
    availableTasks: Task[],
    currentLocation?: { lat: number; lng: number }
  ): Promise<ServiceResult<BatchRecommendation | null>> => {
    try {
      if (availableTasks.length < 2) {
        return { success: true, data: null }; // Need at least 2 tasks to batch
      }

      // Try AI-based optimization first, fall back to heuristics
      let recommendation: BatchRecommendation | null = null;

      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<BatchRecommendation>({
            route: 'reasoning',
            schema: z.object({
              primaryTask: z.object({
                id: z.string(),
                title: z.string(),
                price: z.number(),
                location: z.string(),
                latitude: z.number().optional(),
                longitude: z.number().optional(),
                estimatedDuration: z.number().optional(),
              }),
              additionalTasks: z.array(z.object({
                id: z.string(),
                title: z.string(),
                price: z.number(),
                location: z.string(),
                latitude: z.number().optional(),
                longitude: z.number().optional(),
                estimatedDuration: z.number().optional(),
              })),
              totalEarnings: z.number(),
              totalDuration: z.number(),
              earningsPerHour: z.number(),
              routeDistance: z.number(),
              estimatedTravelTime: z.number(),
              savingsVsIndividual: z.number(),
              confidence: z.number().min(0).max(1),
              reasoning: z.string().min(30),
            }),
            temperature: 0.4,
            timeoutMs: 20000,
            systemPrompt: `You are HustleXP's Route Optimization Agent (A2 authority - proposal only).
Analyze available tasks and propose optimal batching to maximize earnings per hour.
Your proposals are validated by deterministic efficiency thresholds.

CONSTITUTIONAL BOUNDS:
- Minimum earnings: $20/hr
- Maximum batch size: 5 tasks
- Maximum route distance: 5km
- Confidence threshold: >= 0.65

Consider:
1. Geographic clustering (minimize travel time)
2. Time windows (avoid conflicts)
3. Task dependencies (if any)
4. Worker efficiency (batch execution is faster)

Return JSON with EXACTLY these fields:
- primaryTask: The anchor task (highest paying or most central)
- additionalTasks: Up to 4 additional tasks to batch
- totalEarnings: Sum of all task prices (cents)
- totalDuration: Estimated total time including travel (minutes)
- earningsPerHour: Total earnings / (total duration / 60)
- routeDistance: Total distance to complete all tasks (meters)
- estimatedTravelTime: Total travel time (minutes)
- savingsVsIndividual: Time saved vs doing tasks separately (cents value)
- confidence: Your confidence in this recommendation (0.0-1.0)
- reasoning: Why this batch is optimal (minimum 30 chars)`,
            prompt: `Optimize task batching for these available tasks:

${JSON.stringify(availableTasks.slice(0, 15), null, 2)}

${currentLocation ? `Worker current location: (${currentLocation.lat}, ${currentLocation.lng})` : ''}

Find the best combination that maximizes earnings per hour while minimizing travel distance.`,
          });

          recommendation = aiResult.data;
          log.info({
            primaryTaskId: recommendation.primaryTask.id,
            batchSize: recommendation.additionalTasks.length + 1,
            earningsPerHour: recommendation.earningsPerHour,
            confidence: recommendation.confidence,
            provider: aiResult.provider
          }, 'AI batch recommendation generated');
        } catch (aiError) {
          log.warn({ err: aiError instanceof Error ? aiError.message : String(aiError) }, 'AI batch call failed, using heuristic fallback');
          recommendation = TaskBatchingService._generateHeuristicRecommendation(availableTasks, currentLocation);
        }
      } else {
        // No AI configured - use heuristic fallback
        recommendation = TaskBatchingService._generateHeuristicRecommendation(availableTasks, currentLocation);
      }

      if (!recommendation) {
        return { success: true, data: null };
      }

      // CONSTITUTIONAL: Validate proposal against deterministic rules
      const validation = TaskBatchingService._validateRecommendation(recommendation);
      if (!validation.valid) {
        log.warn({ errors: validation.errors }, 'Batch recommendation validation failed');
        return { success: true, data: null }; // Return null instead of error (graceful degradation)
      }

      return { success: true, data: recommendation };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to generate batch recommendation');
      return {
        success: false,
        error: {
          code: 'BATCH_GENERATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to generate recommendation'
        }
      };
    }
  },

  /**
   * Calculate savings from batching tasks together
   */
  calculateSavings: (tasks: Task[]): BatchSavings => {
    const totalEarnings = tasks.reduce((sum, t) => sum + t.price, 0);
    const individualDuration = tasks.reduce((sum, t) => sum + (t.estimatedDuration || 60) + 15, 0); // +15min travel per task
    const combinedDuration = tasks.reduce((sum, t) => sum + (t.estimatedDuration || 60), 0) + 20; // +20min total travel
    const timeSaved = individualDuration - combinedDuration;
    const earningsBoost = Math.round((timeSaved / 60) * 2500); // $25/hr value of time saved

    return {
      totalEarnings,
      combinedDuration,
      individualDuration,
      timeSaved,
      earningsBoost,
    };
  },

  /**
   * Private: Generate heuristic recommendation (fallback when AI unavailable)
   */
  _generateHeuristicRecommendation: (
    tasks: Task[],
    _currentLocation?: { lat: number; lng: number }
  ): BatchRecommendation | null => {
    // Simple clustering: group tasks within 2km of each other
    const tasksWithCoords = tasks.filter(t => t.latitude && t.longitude);
    if (tasksWithCoords.length < 2) return null;

    // Find highest-paying task as anchor
    const primary = tasksWithCoords.reduce((best, t) => t.price > best.price ? t : best);

    // Find nearby tasks (within 2km)
    const nearby = tasksWithCoords.filter(t => {
      if (t.id === primary.id) return false;
      const distance = TaskBatchingService._calculateDistance(
        primary.latitude!,
        primary.longitude!,
        t.latitude!,
        t.longitude!
      );
      return distance <= 2000; // 2km
    });

    if (nearby.length === 0) return null;

    // Take up to 4 additional tasks, sorted by proximity
    const additional = nearby
      .sort((a, b) => {
        const distA = TaskBatchingService._calculateDistance(primary.latitude!, primary.longitude!, a.latitude!, a.longitude!);
        const distB = TaskBatchingService._calculateDistance(primary.latitude!, primary.longitude!, b.latitude!, b.longitude!);
        return distA - distB;
      })
      .slice(0, 4);

    const allTasks = [primary, ...additional];
    const totalEarnings = allTasks.reduce((sum, t) => sum + t.price, 0);
    const totalDuration = allTasks.reduce((sum, t) => sum + (t.estimatedDuration || 60), 0) + 20; // +20min travel
    const earningsPerHour = (totalEarnings / 100) / (totalDuration / 60);
    const routeDistance = additional.reduce((sum, t) =>
      sum + TaskBatchingService._calculateDistance(primary.latitude!, primary.longitude!, t.latitude!, t.longitude!),
      0
    );
    const savings = TaskBatchingService.calculateSavings(allTasks);

    return {
      primaryTask: primary,
      additionalTasks: additional,
      totalEarnings,
      totalDuration,
      earningsPerHour,
      routeDistance,
      estimatedTravelTime: 20,
      savingsVsIndividual: savings.earningsBoost,
      confidence: 0.75,
      reasoning: `Geographic clustering around ${primary.title} with ${additional.length} nearby tasks. Estimated ${Math.round(savings.timeSaved)} minutes saved vs individual completion.`
    };
  },

  /**
   * Private: Validate recommendation against constitutional rules
   */
  _validateRecommendation: (rec: BatchRecommendation): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    // Rule 1: Minimum earnings per hour
    if (rec.earningsPerHour < MIN_EARNINGS_PER_HOUR / 100) {
      errors.push(`BATCH-ERR-001: Earnings per hour $${rec.earningsPerHour.toFixed(2)} below minimum $20/hr`);
    }

    // Rule 2: Maximum batch size
    if (rec.additionalTasks.length + 1 > MAX_BATCH_SIZE) {
      errors.push(`BATCH-ERR-002: Batch size ${rec.additionalTasks.length + 1} exceeds maximum ${MAX_BATCH_SIZE}`);
    }

    // Rule 3: Maximum route distance
    if (rec.routeDistance > MAX_ROUTE_DISTANCE) {
      errors.push(`BATCH-ERR-003: Route distance ${Math.round(rec.routeDistance)}m exceeds maximum ${MAX_ROUTE_DISTANCE}m`);
    }

    // Rule 4: Confidence threshold
    if (rec.confidence < MIN_CONFIDENCE_THRESHOLD) {
      errors.push(`BATCH-ERR-004: Confidence ${(rec.confidence * 100).toFixed(0)}% too low, requires manual review`);
    }

    // Rule 5: Reasoning required
    if (!rec.reasoning || rec.reasoning.length < 30) {
      errors.push('BATCH-ERR-005: Missing or insufficient reasoning');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  },

  /**
   * Private: Calculate distance between two coordinates (Haversine formula)
   */
  _calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  },
};
