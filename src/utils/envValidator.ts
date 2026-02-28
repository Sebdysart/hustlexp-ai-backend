/**
 * Environment Variable Validator — src/ Fastify layer
 *
 * Scans process.env for critical and optional HustleXP configuration.
 *
 * Exports:
 *   validateEnv()   — returns { valid, errors, warnings }
 *   logEnvStatus()  — logs the result using the project logger
 *
 * Critical vars (missing → error, valid=false):
 *   DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *
 * Optional vars (missing → warning, valid unaffected):
 *   OPENAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY,
 *   UPSTASH_REDIS_REST_URL, FIREBASE_PROJECT_ID,
 *   ALLOWED_ORIGINS, OTEL_EXPORTER_OTLP_ENDPOINT
 */

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Config declarations
// ---------------------------------------------------------------------------

/** Variables whose absence is a hard error (server cannot function). */
const REQUIRED_VARS: ReadonlyArray<string> = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

/** Variables whose absence degrades functionality but doesn't block startup. */
const OPTIONAL_VARS: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'OPENAI_API_KEY',             description: 'OpenAI GPT-4o — safety layer disabled' },
  { key: 'GROQ_API_KEY',               description: 'Groq fast inference — fast ops disabled' },
  { key: 'DEEPSEEK_API_KEY',           description: 'DeepSeek reasoning — deep analysis disabled' },
  { key: 'ANTHROPIC_API_KEY',          description: 'Anthropic Claude — alternate model disabled' },
  { key: 'FIREBASE_PROJECT_ID',        description: 'Firebase auth — auth enforcement disabled' },
  { key: 'UPSTASH_REDIS_REST_URL',     description: 'Upstash Redis — rate limiting + caching disabled' },
  { key: 'UPSTASH_REDIS_REST_TOKEN',   description: 'Upstash Redis token — rate limiting disabled' },
  { key: 'ALLOWED_ORIGINS',            description: 'CORS origins — all origins allowed (unsafe in production)' },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', description: 'OpenTelemetry — traces logged to console only' },
];

// ---------------------------------------------------------------------------
// validateEnv
// ---------------------------------------------------------------------------

/**
 * Validate environment configuration.
 * Returns a result object — never throws.
 */
export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Critical variables
  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      errors.push(`${key} is required but not set`);
    }
  }

  // Optional variables
  for (const { key, description } of OPTIONAL_VARS) {
    if (!process.env[key]) {
      warnings.push(`${key} not set — ${description}`);
    }
  }

  // Production-specific checks (warnings only — server still starts without these)
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ALLOWED_ORIGINS) {
      // Server will reject all cross-origin requests but will still start
      warnings.push('ALLOWED_ORIGINS not set in production — all CORS requests will be rejected');
    }
    if (process.env.AI_DEGRADED_MODE === 'true') {
      warnings.push('AI_DEGRADED_MODE=true — all AI requests will be queued, not executed');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// logEnvStatus
// ---------------------------------------------------------------------------

/**
 * Log the result of validateEnv() using the project pino logger.
 * Does not throw — safe to call during server startup.
 */
export function logEnvStatus(result: EnvValidationResult): void {
  if (result.valid) {
    logger.info({ errorCount: 0, warningCount: result.warnings.length }, 'Environment validated ✓');
  } else {
    for (const err of result.errors) {
      logger.error(`ENV ERROR: ${err}`);
    }
  }

  for (const warn of result.warnings) {
    logger.warn(`ENV WARNING: ${warn}`);
  }
}
