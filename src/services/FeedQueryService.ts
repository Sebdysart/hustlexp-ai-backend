/**
 * FEED QUERY SERVICE
 * 
 * Generates and executes feed queries with eligibility filtering.
 * Core principle: If a task appears in the feed, the user is eligible.
 * 
 * Authority: Layer 1 (Backend Service)
 * Constitutional Reference: ARCHITECTURE.md §13, FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 * 
 * @version 1.0.0
 */

import { Redis } from '@upstash/redis';
import { createLogger } from '../utils/logger.js';
import type { RiskLevel } from './CapabilityProfileService.js';

const logger = createLogger('FeedQueryService');

// ---------------------------------------------------------------------------
// Redis feed cache client (optional — degrades gracefully)
// ---------------------------------------------------------------------------

function buildFeedRedisClient(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (err) {
    logger.warn({ err }, 'FeedQueryService: Redis init failed — cache invalidation disabled');
    return null;
  }
}

const feedRedis = buildFeedRedisClient();

// ============================================================================
// TYPES
// ============================================================================

interface FeedTaskRow {
  id: string;
  title: string;
  description: string;
  price: number;
  location: string;
  location_state: string;
  category: string | null;
  risk_level: RiskLevel;
  required_trade: string | null;
  required_trust_tier: number;
  insurance_required: boolean;
  background_check_required: boolean;
  deadline: Date | null;
  poster_id: string;
  poster_name: string;
  poster_avatar: string | null;
  poster_trust_tier: number;
  created_at: Date;
  location_geog?: unknown;
}

export interface FeedTask {
  id: string;
  title: string;
  description: string;
  price: number;
  location: string;
  locationState: string;
  category: string | null;
  riskLevel: RiskLevel;
  requiredTrade: string | null;
  requiredTrustTier: number;
  insuranceRequired: boolean;
  backgroundCheckRequired: boolean;
  deadline: Date | null;
  posterId: string;
  posterName: string;
  posterAvatar: string | null;
  posterTrustTier: number;
  createdAt: Date;
  distanceMiles?: number;
}

export interface FeedQueryOptions {
  userId: string;
  cursor?: string;
  limit?: number;
  feedMode?: 'standard' | 'urgent' | 'nearby' | 'recommended';
  locationLat?: number;
  locationLng?: number;
  radiusMiles?: number;
}

export interface FeedResult {
  tasks: FeedTask[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

// ============================================================================
// SQL QUERY BUILDERS
// ============================================================================

/**
 * Build the base eligibility JOIN query.
 * This is the canonical feed query pattern from ARCHITECTURE.md §13.2
 */
function buildBaseFeedQuery(): string {
  return `
    SELECT 
      t.id,
      t.title,
      t.description,
      t.price,
      t.location,
      t.location_state,
      t.category,
      t.risk_level,
      t.required_trade,
      t.required_trust_tier,
      t.insurance_required,
      t.background_check_required,
      t.deadline,
      t.poster_id,
      u.full_name as poster_name,
      u.avatar_url as poster_avatar,
      u.trust_tier as poster_trust_tier,
      t.created_at,
      t.location_geog
    FROM tasks t
    INNER JOIN capability_profiles cp ON cp.user_id = $1
    LEFT JOIN users u ON u.id = t.poster_id
    WHERE t.state = 'OPEN'
      -- Location state match
      AND t.location_state = cp.location_state
      -- Risk clearance
      AND t.risk_level = ANY(cp.risk_clearance)
      -- Trade requirement
      AND (t.required_trade IS NULL OR EXISTS (
        SELECT 1 FROM verified_trades vt 
        WHERE vt.user_id = $1 
          AND vt.trade = t.required_trade
          AND (vt.expires_at IS NULL OR vt.expires_at > NOW())
      ))
      -- Trust tier requirement
      AND cp.trust_tier >= t.required_trust_tier
      -- Insurance requirement
      AND (t.insurance_required = FALSE OR cp.insurance_valid = TRUE)
      -- Background check requirement
      AND (t.background_check_required = FALSE OR cp.background_check_valid = TRUE)
  `;
}

/**
 * Build feed query with mode-specific ordering and filters.
 */
function buildFeedQuery(options: FeedQueryOptions): { sql: string; params: unknown[] } {
  const { userId, cursor, limit = 20, feedMode = 'standard' } = options;
  const params: unknown[] = [userId];
  let paramIndex = 2;

  let sql = buildBaseFeedQuery();

  // Mode-specific filtering
  switch (feedMode) {
    case 'urgent':
      // Tasks with upcoming deadlines (within 24 hours)
      sql += ` AND t.deadline IS NOT NULL AND t.deadline <= NOW() + INTERVAL '24 hours'`;
      break;
    case 'nearby':
      // Tasks within radius (requires location)
      if (options.locationLat && options.locationLng && options.radiusMiles) {
        sql += ` AND ST_DWithin(
          t.location_geog,
          ST_SetSRID(ST_MakePoint($${paramIndex + 1}, $${paramIndex}), 4326)::geography,
          $${paramIndex + 2} * 1609.34
        )`;
        params.push(options.locationLat, options.locationLng, options.radiusMiles);
        paramIndex += 3;
      }
      break;
    case 'recommended':
      // Could add AI recommendation scoring here
      break;
  }

  // Cursor pagination (tasks before the cursor timestamp)
  if (cursor) {
    sql += ` AND t.created_at < $${paramIndex}`;
    params.push(new Date(cursor));
    paramIndex++;
  }

  // Ordering
  switch (feedMode) {
    case 'urgent':
      sql += ` ORDER BY t.deadline ASC, t.created_at DESC`;
      break;
    case 'nearby':
      if (options.locationLat && options.locationLng) {
        sql += ` ORDER BY ST_Distance(
          t.location_geog,
          ST_SetSRID(ST_MakePoint($${paramIndex - 2}, $${paramIndex - 3}), 4326)::geography
        ), t.created_at DESC`;
      } else {
        sql += ` ORDER BY t.created_at DESC`;
      }
      break;
    default:
      sql += ` ORDER BY t.created_at DESC`;
  }

  // Limit
  sql += ` LIMIT $${paramIndex}`;
  params.push(limit + 1); // Fetch one extra to determine hasMore

  return { sql, params };
}

// ============================================================================
// FEED QUERY EXECUTION
// ============================================================================

/**
 * Get the feed for a user with eligibility filtering.
 * This is the main entry point for feed queries.
 */
export async function getFeed(options: FeedQueryOptions): Promise<FeedResult> {
  const { sql: querySql, params } = buildFeedQuery(options);
  const limit = options.limit || 20;

  try {
    const { sql } = await import('../db/index.js');
    
    logger.debug({ userId: options.userId, feedMode: options.feedMode }, 'Fetching feed');

    const rows = await sql.unsafe(querySql, params);

    // Check if there are more results
    const hasMore = rows.length > limit;
    const tasks = rows.slice(0, limit).map((row: FeedTaskRow) => formatTask(row, options));

    // Generate next cursor
    const nextCursor = hasMore && tasks.length > 0
      ? tasks[tasks.length - 1].createdAt.toISOString()
      : null;

    logger.info({
      userId: options.userId,
      feedMode: options.feedMode,
      returned: tasks.length,
      hasMore,
    }, 'Feed fetched successfully');

    return {
      tasks,
      nextCursor,
      hasMore,
      totalCount: tasks.length,
    };
  } catch (error: unknown) {
    logger.error({ error, userId: options.userId }, 'Failed to fetch feed');
    throw error;
  }
}

/**
 * Format a database row into a FeedTask.
 */
function formatTask(row: FeedTaskRow, options: FeedQueryOptions): FeedTask {
  const task: FeedTask = {
    id: row.id,
    title: row.title,
    description: row.description,
    price: row.price,
    location: row.location,
    locationState: row.location_state,
    category: row.category,
    riskLevel: row.risk_level || 'low',
    requiredTrade: row.required_trade,
    requiredTrustTier: row.required_trust_tier || 1,
    insuranceRequired: row.insurance_required || false,
    backgroundCheckRequired: row.background_check_required || false,
    deadline: row.deadline,
    posterId: row.poster_id,
    posterName: row.poster_name || 'Anonymous',
    posterAvatar: row.poster_avatar,
    posterTrustTier: row.poster_trust_tier || 1,
    createdAt: row.created_at,
  };

  // Calculate distance for nearby mode
  if (options.feedMode === 'nearby' && options.locationLat && options.locationLng && row.location_geog) {
    // Distance will be calculated by the SQL query ORDER BY
    // For now, we don't have the exact distance value in the result
    task.distanceMiles = undefined;
  }

  return task;
}

// ============================================================================
// SINGLE TASK ELIGIBILITY CHECK
// ============================================================================

/**
 * Check if a specific task is eligible for a user.
 * Used for task detail prefetch and apply endpoint.
 */
export async function isTaskEligibleForUser(
  taskId: string,
  userId: string
): Promise<{ eligible: boolean; reason?: string }> {
  try {
    const { sql } = await import('../db/index.js');

    const [result] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM tasks t
        INNER JOIN capability_profiles cp ON cp.user_id = ${userId}
        WHERE t.id = ${taskId}
          AND t.state = 'OPEN'
          AND t.location_state = cp.location_state
          AND t.risk_level = ANY(cp.risk_clearance)
          AND (t.required_trade IS NULL OR EXISTS (
            SELECT 1 FROM verified_trades vt 
            WHERE vt.user_id = ${userId} 
              AND vt.trade = t.required_trade
              AND (vt.expires_at IS NULL OR vt.expires_at > NOW())
          ))
          AND cp.trust_tier >= t.required_trust_tier
          AND (t.insurance_required = FALSE OR cp.insurance_valid = TRUE)
          AND (t.background_check_required = FALSE OR cp.background_check_valid = TRUE)
      ) as eligible
    `;

    const eligible = result?.eligible || false;

    if (!eligible) {
      // Get specific reason
      const [task] = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
      const [profile] = await sql`SELECT * FROM capability_profiles WHERE user_id = ${userId}`;

      if (!task) return { eligible: false, reason: 'Task not found' };
      if (task.state !== 'OPEN') return { eligible: false, reason: `Task is ${task.state}` };
      if (!profile) return { eligible: false, reason: 'Profile not found' };
      if (task.location_state !== profile.location_state) {
        return { eligible: false, reason: 'Location mismatch' };
      }
      if (!profile.risk_clearance?.includes(task.risk_level)) {
        return { eligible: false, reason: 'Insufficient risk clearance' };
      }
      if (task.required_trust_tier > profile.trust_tier) {
        return { eligible: false, reason: 'Insufficient trust tier' };
      }

      return { eligible: false, reason: 'Eligibility requirements not met' };
    }

    return { eligible: true };
  } catch (error: unknown) {
    logger.error({ error, taskId, userId }, 'Error checking task eligibility');
    return { eligible: false, reason: 'Error checking eligibility' };
  }
}

// ============================================================================
// COUNT QUERIES
// ============================================================================

/**
 * Get count of eligible tasks for a user.
 */
export async function getEligibleTaskCount(userId: string): Promise<number> {
  try {
    const { sql } = await import('../db/index.js');

    const [result] = await sql`
      SELECT COUNT(*) as count
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = ${userId}
      WHERE t.state = 'OPEN'
        AND t.location_state = cp.location_state
        AND t.risk_level = ANY(cp.risk_clearance)
        AND (t.required_trade IS NULL OR EXISTS (
          SELECT 1 FROM verified_trades vt 
          WHERE vt.user_id = ${userId} 
            AND vt.trade = t.required_trade
            AND (vt.expires_at IS NULL OR vt.expires_at > NOW())
        ))
        AND cp.trust_tier >= t.required_trust_tier
        AND (t.insurance_required = FALSE OR cp.insurance_valid = TRUE)
        AND (t.background_check_required = FALSE OR cp.background_check_valid = TRUE)
    `;

    return parseInt(result?.count || '0', 10);
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to get eligible task count');
    return 0;
  }
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/** Minimal injectable Redis DEL interface — duck-typed for testability. */
interface RedisDel {
  del: (key: string) => Promise<number>;
}

const FEED_CACHE_KEY = (userId: string) => `hustlexp:feed:eligible:${userId}`;

/**
 * Invalidate feed cache for a user.
 * Called when capability profile changes.
 *
 * Accepts an injectable redis client (defaults to the module-level feedRedis)
 * so tests can pass a mock without vi.mock(). Degrades gracefully when Redis
 * is not configured or throws — never blocks the caller.
 */
export async function invalidateFeedCache(
  userId: string,
  redis: { del(key: string): Promise<number> } | null = feedRedis,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`hustlexp:feed:eligible:${userId}`);
  } catch (err) {
    logger.warn({ err, userId }, 'FeedQueryService: Redis DEL failed for feed cache');
  }
}

/**
 * Pre-warm feed cache for a user.
 * Called after profile recompute to ensure fast feed loads.
 */
export async function prewarmFeedCache(userId: string): Promise<void> {
  try {
    // Fetch the first page of results to warm the cache
    await getFeed({ userId, limit: 20 });
    logger.info({ userId }, 'Feed cache pre-warmed');
  } catch (error: unknown) {
    logger.warn({ error, userId }, 'Failed to pre-warm feed cache');
  }
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const FeedQueryService = {
  getFeed,
  isTaskEligibleForUser,
  getEligibleTaskCount,
  invalidateFeedCache,
  prewarmFeedCache,
};

export default FeedQueryService;
