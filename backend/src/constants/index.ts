// ============================================================================
// HustleXP Constants — Centralized magic numbers and configuration values
// ============================================================================

// ============================================================================
// TIMEOUTS (in milliseconds)
// ============================================================================
export const TIMEOUTS = {
  DB_STATEMENT: 30_000,
  DB_CONNECTION: 10_000,
  DB_IDLE: 30_000,
  AI_DEFAULT: 30_000,
  AI_FAST: 10_000,
  AI_REASONING: 60_000,
  HTTP_DEFAULT: 30_000,
} as const;

// ============================================================================
// DATABASE
// ============================================================================
export const DB_CONFIG = {
  DEFAULT_MAX_CONNECTIONS: 10,
  DEFAULT_MIN_CONNECTIONS: 2,
  MAX_RETRIES: 3,
} as const;

// ============================================================================
// RATE LIMITS
// ============================================================================
export const RATE_LIMITS = {
  AI: { limit: 20, windowSeconds: 60 },
  AUTH: { limit: 10, windowSeconds: 60 },
  ESCROW: { limit: 30, windowSeconds: 60 },
  TASK: { limit: 60, windowSeconds: 60 },
  GENERAL: { limit: 100, windowSeconds: 60 },
} as const;

// ============================================================================
// BUSINESS LOGIC
// ============================================================================
export const BUSINESS = {
  PLATFORM_FEE_PERCENT: 15,
  MIN_TASK_VALUE_CENTS: 500,       // $5.00
  MAX_TASK_VALUE_CENTS: 100_000,   // $1,000
  PREMIUM_MONTHLY_CENTS: 1499,
  PREMIUM_YEARLY_CENTS: 14999,
  PRO_MONTHLY_CENTS: 2999,
  PRO_YEARLY_CENTS: 29999,
} as const;

// ============================================================================
// CACHE TTL (in seconds)
// ============================================================================
export const CACHE_TTL_CONSTANTS = {
  TASK_FEED: 300,        // 5 minutes
  LEADERBOARD: 3600,     // 1 hour
  USER_PROFILE: 600,     // 10 minutes
  AI_RESPONSE: 86400,    // 24 hours
  SESSION: 3600,         // 1 hour
  TASK_DETAILS: 600,     // 10 minutes
  USER_STATS: 1800,      // 30 minutes
} as const;

// ============================================================================
// INPUT LIMITS
// ============================================================================
export const INPUT_LIMITS = {
  TITLE_MAX: 255,
  DESCRIPTION_MAX: 10_000,
  REQUIREMENTS_MAX: 5_000,
  LOCATION_MAX: 500,
  CATEGORY_MAX: 100,
  TEXT_INPUT_MAX: 50_000,
  AI_INPUT_MAX: 4_000,
  PAGINATION_LIMIT_MAX: 100,
  PAGINATION_OFFSET_MAX: 10_000,
  BROADCAST_RADIUS_MAX: 100,
} as const;
