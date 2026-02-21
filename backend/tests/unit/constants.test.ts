/**
 * Constants Module Unit Tests
 *
 * Verifies all configuration constants are defined correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  TIMEOUTS,
  DB_CONFIG,
  RATE_LIMITS,
  BUSINESS,
  CACHE_TTL_CONSTANTS,
  INPUT_LIMITS,
} from '../../src/constants';

describe('TIMEOUTS', () => {
  it('should have all expected properties', () => {
    expect(TIMEOUTS.DB_STATEMENT).toBe(30_000);
    expect(TIMEOUTS.DB_CONNECTION).toBe(10_000);
    expect(TIMEOUTS.DB_IDLE).toBe(30_000);
    expect(TIMEOUTS.AI_DEFAULT).toBe(30_000);
    expect(TIMEOUTS.AI_FAST).toBe(10_000);
    expect(TIMEOUTS.AI_REASONING).toBe(60_000);
    expect(TIMEOUTS.HTTP_DEFAULT).toBe(30_000);
  });

  it('should all be positive numbers', () => {
    for (const [, val] of Object.entries(TIMEOUTS)) {
      expect(val).toBeGreaterThan(0);
    }
  });

  it('AI reasoning should be the longest AI timeout', () => {
    expect(TIMEOUTS.AI_REASONING).toBeGreaterThan(TIMEOUTS.AI_DEFAULT);
    expect(TIMEOUTS.AI_REASONING).toBeGreaterThan(TIMEOUTS.AI_FAST);
  });
});

describe('DB_CONFIG', () => {
  it('should have expected values', () => {
    expect(DB_CONFIG.DEFAULT_MAX_CONNECTIONS).toBe(10);
    expect(DB_CONFIG.DEFAULT_MIN_CONNECTIONS).toBe(2);
    expect(DB_CONFIG.MAX_RETRIES).toBe(3);
  });

  it('max connections should be greater than min', () => {
    expect(DB_CONFIG.DEFAULT_MAX_CONNECTIONS).toBeGreaterThan(DB_CONFIG.DEFAULT_MIN_CONNECTIONS);
  });
});

describe('RATE_LIMITS', () => {
  it('should have expected limits', () => {
    expect(RATE_LIMITS.AI.limit).toBe(20);
    expect(RATE_LIMITS.AUTH.limit).toBe(10);
    expect(RATE_LIMITS.ESCROW.limit).toBe(30);
    expect(RATE_LIMITS.TASK.limit).toBe(60);
    expect(RATE_LIMITS.GENERAL.limit).toBe(100);
  });

  it('all window sizes should be 60 seconds', () => {
    for (const [, cfg] of Object.entries(RATE_LIMITS)) {
      expect(cfg.windowSeconds).toBe(60);
    }
  });

  it('general limit should be the highest', () => {
    expect(RATE_LIMITS.GENERAL.limit).toBeGreaterThanOrEqual(RATE_LIMITS.AI.limit);
    expect(RATE_LIMITS.GENERAL.limit).toBeGreaterThanOrEqual(RATE_LIMITS.AUTH.limit);
    expect(RATE_LIMITS.GENERAL.limit).toBeGreaterThanOrEqual(RATE_LIMITS.ESCROW.limit);
    expect(RATE_LIMITS.GENERAL.limit).toBeGreaterThanOrEqual(RATE_LIMITS.TASK.limit);
  });

  it('auth should be the most restrictive', () => {
    expect(RATE_LIMITS.AUTH.limit).toBeLessThanOrEqual(RATE_LIMITS.AI.limit);
    expect(RATE_LIMITS.AUTH.limit).toBeLessThanOrEqual(RATE_LIMITS.ESCROW.limit);
  });
});

describe('BUSINESS', () => {
  it('should have expected values', () => {
    expect(BUSINESS.PLATFORM_FEE_PERCENT).toBe(15);
    expect(BUSINESS.MIN_TASK_VALUE_CENTS).toBe(500);
    expect(BUSINESS.MAX_TASK_VALUE_CENTS).toBe(100_000);
  });

  it('max task value should exceed min', () => {
    expect(BUSINESS.MAX_TASK_VALUE_CENTS).toBeGreaterThan(BUSINESS.MIN_TASK_VALUE_CENTS);
  });

  it('min task value should be at least $5', () => {
    expect(BUSINESS.MIN_TASK_VALUE_CENTS).toBeGreaterThanOrEqual(500);
  });

  it('subscription pricing should be sensible', () => {
    expect(BUSINESS.PREMIUM_YEARLY_CENTS).toBeGreaterThan(BUSINESS.PREMIUM_MONTHLY_CENTS);
    expect(BUSINESS.PRO_YEARLY_CENTS).toBeGreaterThan(BUSINESS.PRO_MONTHLY_CENTS);
    expect(BUSINESS.PRO_MONTHLY_CENTS).toBeGreaterThan(BUSINESS.PREMIUM_MONTHLY_CENTS);
  });
});

describe('CACHE_TTL_CONSTANTS', () => {
  it('should have expected values', () => {
    expect(CACHE_TTL_CONSTANTS.TASK_FEED).toBe(300);
    expect(CACHE_TTL_CONSTANTS.LEADERBOARD).toBe(3600);
    expect(CACHE_TTL_CONSTANTS.USER_PROFILE).toBe(600);
    expect(CACHE_TTL_CONSTANTS.AI_RESPONSE).toBe(86400);
    expect(CACHE_TTL_CONSTANTS.SESSION).toBe(3600);
  });

  it('should all be positive numbers', () => {
    for (const [, val] of Object.entries(CACHE_TTL_CONSTANTS)) {
      expect(val).toBeGreaterThan(0);
    }
  });

  it('AI response cache should be longest', () => {
    expect(CACHE_TTL_CONSTANTS.AI_RESPONSE).toBeGreaterThan(CACHE_TTL_CONSTANTS.LEADERBOARD);
    expect(CACHE_TTL_CONSTANTS.AI_RESPONSE).toBeGreaterThan(CACHE_TTL_CONSTANTS.USER_PROFILE);
  });
});

describe('INPUT_LIMITS', () => {
  it('should have expected values', () => {
    expect(INPUT_LIMITS.TITLE_MAX).toBe(255);
    expect(INPUT_LIMITS.DESCRIPTION_MAX).toBe(10_000);
    expect(INPUT_LIMITS.REQUIREMENTS_MAX).toBe(5_000);
    expect(INPUT_LIMITS.LOCATION_MAX).toBe(500);
    expect(INPUT_LIMITS.CATEGORY_MAX).toBe(100);
    expect(INPUT_LIMITS.PAGINATION_LIMIT_MAX).toBe(100);
    expect(INPUT_LIMITS.BROADCAST_RADIUS_MAX).toBe(100);
  });

  it('description should be longer than title', () => {
    expect(INPUT_LIMITS.DESCRIPTION_MAX).toBeGreaterThan(INPUT_LIMITS.TITLE_MAX);
  });

  it('all values should be positive', () => {
    for (const [, val] of Object.entries(INPUT_LIMITS)) {
      expect(val).toBeGreaterThan(0);
    }
  });
});
