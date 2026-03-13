/**
 * FlagsService v1.0.0
 *
 * Feature flag evaluation with Redis caching and deterministic rollout.
 *
 * @see backend/database/constitutional-schema.sql
 */

import { Redis } from '@upstash/redis';
import { db } from '../db.js';
import { config } from '../config.js';


// ============================================================================
// REDIS CACHE
// ============================================================================

let flagsRedis: Redis | null = null;
function getRedis(): Redis | null {
  if (!flagsRedis && config.redis.restUrl && config.redis.restToken) {
    flagsRedis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
  }
  return flagsRedis;
}

const CACHE_TTL = 60; // 60 seconds
const CACHE_PREFIX = 'ff:';

// ============================================================================
// DJB2 HASH (deterministic rollout)
// ============================================================================

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ============================================================================
// TYPES
// ============================================================================

interface FeatureFlag {
  id: string;
  name: string;
  enabled: boolean;
  rollout_percentage: number;
  user_allowlist: string[];
  user_blocklist: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface EvaluatedFlag {
  name: string;
  enabled: boolean;
}

// ============================================================================
// SERVICE
// ============================================================================

export const FlagsService = {
  /**
   * Get all flags evaluated for a specific user
   */
  getUserFlags: async (userId: string): Promise<EvaluatedFlag[]> => {
    const flags = await FlagsService.getAllFlags();
    return flags.map(flag => ({
      name: flag.name,
      enabled: evaluateFlag(flag, userId),
    }));
  },

  /**
   * Get a single flag evaluated for a specific user
   */
  getFlagForUser: async (flagName: string, userId: string): Promise<boolean> => {
    const redis = getRedis();
    const cacheKey = `${CACHE_PREFIX}${flagName}`;

    // Try cache first
    if (redis) {
      try {
        const cached = await redis.get<string>(cacheKey);
        if (cached) {
          const flag: FeatureFlag = JSON.parse(cached);
          return evaluateFlag(flag, userId);
        }
      } catch {
        // Cache miss or error, fall through to DB
      }
    }

    // Query DB
    const result = await db.query<FeatureFlag>(
      'SELECT * FROM feature_flags WHERE name = $1',
      [flagName]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const flag = result.rows[0];

    // Cache the flag
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(flag), { ex: CACHE_TTL });
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return evaluateFlag(flag, userId);
  },

  /**
   * Set (create or update) a feature flag
   */
  setFlag: async (params: {
    name: string;
    enabled: boolean;
    rolloutPercentage?: number;
    userAllowlist?: string[];
    userBlocklist?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<FeatureFlag> => {
    const {
      name,
      enabled,
      rolloutPercentage = 0,
      userAllowlist = [],
      userBlocklist = [],
      metadata = {},
    } = params;

    const result = await db.query<FeatureFlag>(
      `INSERT INTO feature_flags (name, enabled, rollout_percentage, user_allowlist, user_blocklist, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::JSONB)
       ON CONFLICT (name) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         rollout_percentage = EXCLUDED.rollout_percentage,
         user_allowlist = EXCLUDED.user_allowlist,
         user_blocklist = EXCLUDED.user_blocklist,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [name, enabled, rolloutPercentage, userAllowlist, userBlocklist, JSON.stringify(metadata)]
    );

    const flag = result.rows[0];

    // Invalidate cache
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(`${CACHE_PREFIX}${name}`);
        await redis.del(`${CACHE_PREFIX}all`);
      } catch {
        // Cache invalidation failure is non-fatal
      }
    }

    return flag;
  },

  /**
   * Get all feature flags (raw, not evaluated)
   */
  getAllFlags: async (): Promise<FeatureFlag[]> => {
    const redis = getRedis();
    const cacheKey = `${CACHE_PREFIX}all`;

    // Try cache first
    if (redis) {
      try {
        const cached = await redis.get<string>(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch {
        // Cache miss or error, fall through to DB
      }
    }

    const result = await db.query<FeatureFlag>(
      'SELECT * FROM feature_flags ORDER BY name'
    );

    const flags = result.rows;

    // Cache all flags
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(flags), { ex: CACHE_TTL });
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return flags;
  },
};

// ============================================================================
// HELPERS
// ============================================================================

function evaluateFlag(flag: FeatureFlag, userId: string): boolean {
  // Blocklist takes priority
  if (flag.user_blocklist?.includes(userId)) {
    return false;
  }

  // Allowlist overrides rollout
  if (flag.user_allowlist?.includes(userId)) {
    return flag.enabled;
  }

  // If not globally enabled, flag is off
  if (!flag.enabled) {
    return false;
  }

  // 100% rollout = enabled for everyone
  if (flag.rollout_percentage >= 100) {
    return true;
  }

  // 0% rollout = disabled for everyone (unless allowlisted)
  if (flag.rollout_percentage <= 0) {
    return false;
  }

  // Deterministic rollout: hash(userId + flagName) % 100 < rollout_percentage
  const bucket = djb2Hash(userId + flag.name) % 100;
  return bucket < flag.rollout_percentage;
}
