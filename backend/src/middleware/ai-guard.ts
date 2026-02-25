/**
 * AI Output Validation Guard
 *
 * Defense-in-depth layer that validates all AI-generated output before
 * it reaches users. Prevents prompt injection leakage, PII exposure,
 * and malformed responses.
 *
 * PRODUCT_SPEC §7.3: AI Safety Requirements
 */

import { logger } from '../logger';

const log = logger.child({ module: 'ai-guard' });

// ============================================================================
// TYPES
// ============================================================================

export interface AIValidationResult {
  valid: boolean;
  sanitized: string;
  violations: string[];
  costEstimate?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUSD: number;
  };
}

export interface AIUsageMetrics {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  userId?: string;
  endpoint: string;
}

// ============================================================================
// VALIDATION PATTERNS
// ============================================================================

/** Patterns that indicate prompt injection leakage in AI output */
const LEAKAGE_PATTERNS = [
  /you\s+are\s+(a|an)\s+(AI|language\s+model|assistant)/i,
  /as\s+an?\s+AI\s+(language\s+)?model/i,
  /I('m|\s+am)\s+an?\s+(AI|language\s+model)/i,
  /my\s+system\s+prompt/i,
  /my\s+instructions\s+(say|tell|are)/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<SYS>>/i,
];

/** PII patterns that should never appear in AI output */
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,          // SSN
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // Credit card
  /\bsk_live_[a-zA-Z0-9]+\b/,       // Stripe secret key
  /\bsk_test_[a-zA-Z0-9]+\b/,       // Stripe test key
  /\brk_live_[a-zA-Z0-9]+\b/,       // Stripe restricted key
  /\bwhsec_[a-zA-Z0-9]+\b/,         // Stripe webhook secret
  /\bAIza[0-9A-Za-z_-]{35}\b/,      // Google API key
  /\bghp_[a-zA-Z0-9]{36}\b/,        // GitHub PAT
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, // Private keys
];

/** Maximum output length (prevent token exhaustion attacks) */
const MAX_OUTPUT_LENGTH = 10000;

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate AI-generated output before returning to user.
 * Returns sanitized output and list of violations found.
 */
export function validateAIOutput(output: string): AIValidationResult {
  const violations: string[] = [];
  let sanitized = output;

  // 1. Null/empty check
  if (!output || typeof output !== 'string') {
    return {
      valid: false,
      sanitized: '',
      violations: ['Empty or non-string output'],
    };
  }

  // 2. Length check (prevent token exhaustion)
  if (output.length > MAX_OUTPUT_LENGTH) {
    sanitized = output.slice(0, MAX_OUTPUT_LENGTH) + '... [truncated]';
    violations.push(`Output exceeded max length (${output.length} > ${MAX_OUTPUT_LENGTH})`);
  }

  // 3. Prompt injection leakage check
  for (const pattern of LEAKAGE_PATTERNS) {
    if (pattern.test(sanitized)) {
      violations.push(`Prompt leakage detected: ${pattern.source}`);
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }

  // 4. PII/secret exposure check
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(sanitized)) {
      violations.push(`PII/secret detected: ${pattern.source}`);
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }

  // 5. Control character removal
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Log violations for monitoring
  if (violations.length > 0) {
    log.warn({ violations, outputLength: output.length }, 'AI output validation violations');
  }

  return {
    valid: violations.length === 0,
    sanitized,
    violations,
  };
}

// ============================================================================
// COST TRACKING
// ============================================================================

/** Approximate per-token costs (USD) for supported models */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 0.0000025, output: 0.00001 },
  'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
  'gpt-4-turbo': { input: 0.00001, output: 0.00003 },
  // Anthropic
  'claude-3-5-sonnet': { input: 0.000003, output: 0.000015 },
  'claude-3-haiku': { input: 0.00000025, output: 0.00000125 },
  // Google
  'gemini-1.5-pro': { input: 0.00000125, output: 0.000005 },
  'gemini-1.5-flash': { input: 0.000000075, output: 0.0000003 },
  // Groq
  'llama-3.1-70b-versatile': { input: 0.00000059, output: 0.00000079 },
  // Default fallback
  'default': { input: 0.000005, output: 0.000015 },
};

/**
 * Estimate the cost of an AI API call
 */
export function estimateAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = MODEL_COSTS[model] || MODEL_COSTS['default'];
  return (inputTokens * costs.input) + (outputTokens * costs.output);
}

/**
 * Track AI usage metrics.
 * In production, this would emit to a metrics system (Prometheus, Datadog, etc.)
 * For alpha, we log structured JSON for aggregation.
 */
export function trackAIUsage(metrics: AIUsageMetrics): void {
  const cost = estimateAICost(metrics.model, metrics.inputTokens, metrics.outputTokens);

  log.info({
    ...metrics,
    estimatedCostUSD: cost,
    type: 'ai_usage',
  }, 'AI usage tracked');
}

// ============================================================================
// DAILY COST BUDGET (Alpha Guardrail)
// ============================================================================

const DAILY_COST_BUDGET_USD = 50; // $50/day cap for alpha

// In-memory fallback for when Redis is unavailable
let localDailyCostAccumulator = 0;
let localLastResetDate = new Date().toDateString();

/**
 * Check if AI spending is within daily budget.
 * Uses Redis for cross-instance tracking when available, falls back to in-memory.
 * Resets at midnight UTC.
 */
export async function checkAIBudget(estimatedCost: number): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const redisKey = `ai:daily_cost:${today}`;

  // Try Redis-backed tracking first (cross-instance safe)
  try {
    const { Redis } = await import('@upstash/redis');
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (redisUrl && redisToken) {
      const redis = new Redis({ url: redisUrl, token: redisToken });

      // Atomic increment to avoid concurrency race conditions across instances.
      // NOTE: Upstash Redis supports INCRBYFLOAT.
      const newCost = await redis.incrbyfloat(redisKey, estimatedCost);

      // If this request pushes us over budget, roll back the increment and reject.
      if (newCost > DAILY_COST_BUDGET_USD) {
        await redis.incrbyfloat(redisKey, -estimatedCost);

        const previousCost = newCost - estimatedCost;
        log.error({
          dailyCost: previousCost,
          requestCost: estimatedCost,
          budget: DAILY_COST_BUDGET_USD,
          source: 'redis',
        }, 'AI daily budget exceeded');

        return { allowed: false, remaining: DAILY_COST_BUDGET_USD - previousCost };
      }

      // Ensure the key expires (25 hours). Only set TTL if missing.
      // Wrap in its own try/catch — TTL is housekeeping, not critical path.
      // If this fails, the increment is already committed; we must NOT fall
      // through to in-memory (which would double-count the cost).
      try {
        const ttl = await redis.ttl(redisKey);
        if (ttl < 0) {
          await redis.expire(redisKey, 90000);
        }
      } catch (ttlErr) {
        log.warn({ ttlErr, redisKey }, 'Redis TTL housekeeping failed (non-critical)');
      }

      return { allowed: true, remaining: DAILY_COST_BUDGET_USD - newCost };
    }
  } catch (redisErr) {
    log.warn({ redisErr }, 'Redis AI budget tracking unavailable — falling back to in-memory');
  }

  // Fallback: in-memory tracking (single-instance only)
  const todayLocal = new Date().toDateString();
  if (todayLocal !== localLastResetDate) {
    localDailyCostAccumulator = 0;
    localLastResetDate = todayLocal;
  }

  if (localDailyCostAccumulator + estimatedCost > DAILY_COST_BUDGET_USD) {
    log.error({
      dailyCost: localDailyCostAccumulator,
      requestCost: estimatedCost,
      budget: DAILY_COST_BUDGET_USD,
      source: 'memory',
    }, 'AI daily budget exceeded');
    return { allowed: false, remaining: DAILY_COST_BUDGET_USD - localDailyCostAccumulator };
  }

  localDailyCostAccumulator += estimatedCost;
  return { allowed: true, remaining: DAILY_COST_BUDGET_USD - localDailyCostAccumulator };
}
