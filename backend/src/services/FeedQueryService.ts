/**
 * FeedQueryService v1.0.0
 * 
 * CONSTITUTIONAL: Task discovery feed for HustleXP
 * 
 * Queries tasks from the database and filters them based on:
 * - User eligibility (capabilities, location)
 * - Task requirements (trade, risk level)
 * - Real-time availability
 * - Geographic proximity (when location provided)
 * 
 * This is the core service that enables task discovery for hustlers.
 * 
 * @see ARCHITECTURE.md §12.1
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { CapabilityProfile } from './CapabilityProfileService.js';
import { isEligible } from './EligibilityResolverService.js';

const log = logger.child({ service: 'FeedQueryService' });

// ============================================================================
// TYPES
// ============================================================================

export interface FeedQuery {
  userId: string;
  capabilityProfile: CapabilityProfile;
  location?: {
    lat: number;
    lng: number;
  };
  radiusMiles?: number;
  filters?: {
    trades?: string[];
    minPayout?: number;
    maxPayout?: number;
    riskLevels?: string[];
  };
  pagination: {
    cursor?: string;
    limit: number;
  };
}

export interface FeedTask {
  id: string;
  title: string;
  description: string;
  trade: string;
  location: {
    address: string;
    city: string;
    state: string;
    lat: number;
    lng: number;
  };
  payout: {
    cents: number;
    currency: string;
  };
  riskLevel: string;
  estimatedDuration: number; // minutes
  requiredInsurance: boolean;
  requiredBackgroundCheck: boolean;
  postedAt: string;
  poster: {
    id: string;
    rating: number;
    completedTasks: number;
  };
  eligibility: {
    eligible: boolean;
    code: string;
    reasons: string[];
  };
  distance?: number; // miles, if location provided
}

export interface FeedResult {
  tasks: FeedTask[];
  nextCursor?: string;
  totalCount: number;
  filters: {
    applied: string[];
    excluded: number;
  };
}

// ============================================================================
// ROW TYPES
// ============================================================================

interface TaskFeedRow {
  id: string;
  title: string;
  description: string;
  trade: string;
  location_address: string;
  location_city: string;
  location_state: string;
  location_lat: number;
  location_lng: number;
  payout_cents: number;
  currency: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  estimated_duration_minutes: number;
  insurance_required: boolean;
  background_check_required: boolean;
  created_at: string;
  poster_id: string;
  poster_rating: number;
  poster_completed_tasks: number;
}

// ============================================================================
// CORE QUERY
// ============================================================================

/**
 * Query tasks for user feed
 * 
 * This is the main entry point for task discovery.
 * It queries available tasks and filters by eligibility.
 */
export async function queryFeed(query: FeedQuery): Promise<FeedResult> {
  const startTime = Date.now();
  const appliedFilters: string[] = [];

  // Build base query
  let sql = `
    SELECT 
      t.id,
      t.title,
      t.description,
      t.trade_type as trade,
      t.location_address,
      t.location_city,
      t.location_state,
      t.location_lat,
      t.location_lng,
      t.payout_cents,
      t.currency,
      t.risk_level,
      t.estimated_duration_minutes,
      t.insurance_required,
      t.background_check_required,
      t.created_at,
      t.poster_id,
      u.rating as poster_rating,
      u.completed_tasks_count as poster_completed_tasks
    FROM tasks t
    JOIN users u ON t.poster_id = u.id
    WHERE t.state = 'OPEN'
      AND t.poster_id != $1
      AND NOT EXISTS (
        SELECT 1 FROM applications a 
        WHERE a.task_id = t.id 
        AND a.hustler_id = $1
      )
  `;

  const params: unknown[] = [query.userId];
  let paramIndex = 2;

  // Apply trade filter
  if (query.filters?.trades && query.filters.trades.length > 0) {
    sql += ` AND t.trade_type = ANY($${paramIndex})`;
    params.push(query.filters.trades);
    paramIndex++;
    appliedFilters.push('trade');
  } else {
    // Filter to user's verified trades
    const userTrades = query.capabilityProfile.verifiedTrades.map(t => t.trade);
    if (userTrades.length > 0) {
      sql += ` AND t.trade_type = ANY($${paramIndex})`;
      params.push(userTrades);
      paramIndex++;
      appliedFilters.push('verified_trades');
    }
  }

  // Apply payout filters
  if (query.filters?.minPayout) {
    sql += ` AND t.payout_cents >= $${paramIndex}`;
    params.push(query.filters.minPayout * 100);
    paramIndex++;
    appliedFilters.push('min_payout');
  }

  if (query.filters?.maxPayout) {
    sql += ` AND t.payout_cents <= $${paramIndex}`;
    params.push(query.filters.maxPayout * 100);
    paramIndex++;
    appliedFilters.push('max_payout');
  }

  // Apply risk level filter
  if (query.filters?.riskLevels && query.filters.riskLevels.length > 0) {
    sql += ` AND t.risk_level = ANY($${paramIndex})`;
    params.push(query.filters.riskLevels);
    paramIndex++;
    appliedFilters.push('risk_level');
  } else {
    // Filter to user's risk clearance
    sql += ` AND t.risk_level = ANY($${paramIndex})`;
    params.push(query.capabilityProfile.riskClearance);
    paramIndex++;
    appliedFilters.push('risk_clearance');
  }

  // Apply location filter (if provided)
  if (query.location && query.radiusMiles) {
    // Haversine formula for distance calculation
    sql += ` AND (
      3959 * acos(
        cos(radians($${paramIndex})) * cos(radians(t.location_lat)) *
        cos(radians(t.location_lng) - radians($${paramIndex + 1})) +
        sin(radians($${paramIndex})) * sin(radians(t.location_lat))
      )
    ) <= $${paramIndex + 2}`;
    params.push(query.location.lat, query.location.lng, query.radiusMiles);
    paramIndex += 3;
    appliedFilters.push('location');
  }

  // Apply cursor pagination
  if (query.pagination.cursor) {
    sql += ` AND t.created_at < $${paramIndex}`;
    params.push(new Date(query.pagination.cursor));
    paramIndex++;
  }

  // Order and limit
  sql += ` ORDER BY t.created_at DESC LIMIT $${paramIndex}`;
  params.push(query.pagination.limit);

  // Execute query
  const result = await db.query<TaskFeedRow>(sql, params);

  log.debug({ 
    userId: query.userId, 
    rawCount: result.rows.length,
    duration: Date.now() - startTime 
  }, 'Feed query executed');

  // Transform and filter by eligibility
  const tasks: FeedTask[] = [];
  let excludedCount = 0;

  for (const row of result.rows) {
    // Check eligibility
    const eligibilityResult = isEligible(
      {
        trade: row.trade,
        state: row.location_state,
        riskLevel: row.risk_level,
        insuranceRequired: row.insurance_required,
        backgroundCheckRequired: row.background_check_required,
      },
      {
        userId: query.userId,
        capabilityProfile: query.capabilityProfile,
        activeTaskCount: 0, // Would need to query this
        hasActiveDispute: false, // Would need to query this
        accountAgeDays: 30, // Would need to query this
        trustScore: 4.5, // Would need to query this
      }
    );

    // Calculate distance if location provided
    let distance: number | undefined;
    if (query.location && row.location_lat && row.location_lng) {
      distance = calculateDistance(
        query.location.lat,
        query.location.lng,
        row.location_lat,
        row.location_lng
      );
    }

    const task: FeedTask = {
      id: row.id,
      title: row.title,
      description: row.description,
      trade: row.trade,
      location: {
        address: row.location_address,
        city: row.location_city,
        state: row.location_state,
        lat: row.location_lat,
        lng: row.location_lng,
      },
      payout: {
        cents: row.payout_cents,
        currency: row.currency || 'USD',
      },
      riskLevel: row.risk_level,
      estimatedDuration: row.estimated_duration_minutes,
      requiredInsurance: row.insurance_required,
      requiredBackgroundCheck: row.background_check_required,
      postedAt: row.created_at,
      poster: {
        id: row.poster_id,
        rating: row.poster_rating || 0,
        completedTasks: row.poster_completed_tasks || 0,
      },
      eligibility: {
        eligible: eligibilityResult.eligible,
        code: eligibilityResult.code,
        reasons: eligibilityResult.reasons,
      },
      distance,
    };

    // Only include eligible tasks in feed
    if (eligibilityResult.eligible) {
      tasks.push(task);
    } else {
      excludedCount++;
    }
  }

  // Get next cursor from last task
  const nextCursor = tasks.length > 0 
    ? tasks[tasks.length - 1].postedAt 
    : undefined;

  log.info({ 
    userId: query.userId, 
    returnedCount: tasks.length,
    excludedCount,
    duration: Date.now() - startTime 
  }, 'Feed query completed');

  return {
    tasks,
    nextCursor,
    totalCount: tasks.length,
    filters: {
      applied: appliedFilters,
      excluded: excludedCount,
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate distance between two points using Haversine formula
 */
function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// ============================================================================
// SIMPLIFIED QUERIES
// ============================================================================

/**
 * Get tasks near a location (simple query without eligibility filtering)
 */
export async function getNearbyTasks(
  lat: number,
  lng: number,
  radiusMiles: number,
  limit: number = 20
): Promise<Array<{ id: string; title: string; lat: number; lng: number; payoutCents: number }>> {
  const result = await db.query<{ id: string; title: string; lat: number; lng: number; payoutCents: number }>(
    `
    SELECT 
      id, title, location_lat as lat, location_lng as lng, payout_cents
    FROM tasks
    WHERE state = 'OPEN'
      AND location_lat IS NOT NULL
      AND location_lng IS NOT NULL
      AND (
        3959 * acos(
          cos(radians($1)) * cos(radians(location_lat)) *
          cos(radians(location_lng) - radians($2)) +
          sin(radians($1)) * sin(radians(location_lat))
        )
      ) <= $3
    ORDER BY created_at DESC
    LIMIT $4
    `,
    [lat, lng, radiusMiles, limit]
  );

  return result.rows;
}

/**
 * Get tasks by trade
 */
export async function getTasksByTrade(
  trade: string,
  state: string,
  limit: number = 20
): Promise<FeedTask[]> {
  const result = await db.query<{
    id: string;
    title: string;
    description: string;
    trade_type: string;
    location_address: string;
    location_city: string;
    location_state: string;
    location_lat: number;
    location_lng: number;
    payout_cents: number;
    currency: string;
    risk_level: string;
    estimated_duration_minutes: number;
    insurance_required: boolean;
    background_check_required: boolean;
    created_at: string;
    poster_id: string;
    poster_rating: number;
    completed_tasks_count: number;
  }>(
    `
    SELECT
      t.id, t.title, t.description, t.trade_type, t.location_address,
      t.location_city, t.location_state, t.location_lat, t.location_lng,
      t.payout_cents, t.currency, t.risk_level, t.estimated_duration_minutes,
      t.insurance_required, t.background_check_required, t.created_at,
      t.poster_id, u.rating as poster_rating, u.completed_tasks_count
    FROM tasks t
    JOIN users u ON t.poster_id = u.id
    WHERE t.state = 'OPEN'
      AND t.trade_type = $1
      AND t.location_state = $2
    ORDER BY t.created_at DESC
    LIMIT $3
    `,
    [trade, state, limit]
  );

  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    trade: row.trade_type,
    location: {
      address: row.location_address,
      city: row.location_city,
      state: row.location_state,
      lat: row.location_lat,
      lng: row.location_lng,
    },
    payout: {
      cents: row.payout_cents,
      currency: row.currency || 'USD',
    },
    riskLevel: row.risk_level,
    estimatedDuration: row.estimated_duration_minutes,
    requiredInsurance: row.insurance_required,
    requiredBackgroundCheck: row.background_check_required,
    postedAt: row.created_at,
    poster: {
      id: row.poster_id,
      rating: row.poster_rating || 0,
      completedTasks: row.completed_tasks_count || 0,
    },
    eligibility: {
      eligible: false, // Would need user context
      code: 'HX400',
      reasons: [],
    },
  }));
}

export default {
  queryFeed,
  getNearbyTasks,
  getTasksByTrade,
};
