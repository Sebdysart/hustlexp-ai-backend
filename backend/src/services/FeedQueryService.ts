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
import {
  taskEligibilityJoins,
  taskEligibilityPredicates,
} from './TaskEligibilityPolicy.js';

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
    states?: string[];
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
  risk_level: 'low' | 'medium' | 'high' | 'in_home';
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
  if (query.capabilityProfile.userId !== query.userId) {
    throw new Error('Capability profile does not belong to the requested user');
  }

  // Eligibility is enforced entirely by authoritative database state. The
  // caller-provided profile is only a freshness witness populated by the
  // router; it never supplies safety predicates or widens this result.
  let sql = `
    SELECT
      t.id,
      t.title,
      t.description,
      COALESCE(t.trade_type, t.category, 'general') AS trade,
      COALESCE(t.rough_location, t.location, '') AS location_address,
      COALESCE(t.rough_location, t.location, '') AS location_city,
      t.location_state,
      t.location_lat,
      t.location_lng,
      t.hustler_payout_cents AS payout_cents,
      COALESCE(t.currency, 'USD') AS currency,
      lower(t.risk_level) AS risk_level,
      COALESCE(t.estimated_duration_minutes, 60) AS estimated_duration_minutes,
      t.insurance_required,
      t.background_check_required,
      t.created_at,
      t.poster_id,
      COALESCE(poster_stats.rating, 0) AS poster_rating,
      COALESCE(poster_stats.completed_tasks, 0) AS poster_completed_tasks
    FROM tasks t
    ${taskEligibilityJoins('$1', {
      task: 't',
      worker: 'worker',
      profile: 'cp',
      escrow: 'escrow',
    })}
    JOIN users poster ON poster.id = t.poster_id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE((
          SELECT AVG(r.stars)::numeric
          FROM task_ratings r
          WHERE r.ratee_id = poster.id
        ), 0) AS rating,
        (
          SELECT COUNT(*)::integer
          FROM tasks completed
          WHERE completed.poster_id = poster.id AND completed.state = 'COMPLETED'
        ) AS completed_tasks
    ) poster_stats ON TRUE
    WHERE t.state = 'OPEN'
      ${taskEligibilityPredicates({
        task: 't',
        worker: 'worker',
        profile: 'cp',
        escrow: 'escrow',
      })}
  `;

  const params: unknown[] = [query.userId];
  let paramIndex = 2;

  if (query.filters?.trades && query.filters.trades.length > 0) {
    sql += ` AND t.trade_type = ANY($${paramIndex})`;
    params.push(query.filters.trades);
    paramIndex++;
    appliedFilters.push('trade');
  }

  if (query.filters?.states && query.filters.states.length > 0) {
    sql += ` AND t.location_state = ANY($${paramIndex})`;
    params.push(query.filters.states);
    paramIndex++;
    appliedFilters.push('state');
  }

  if (query.filters?.minPayout !== undefined) {
    sql += ` AND t.hustler_payout_cents >= $${paramIndex}`;
    params.push(query.filters.minPayout * 100);
    paramIndex++;
    appliedFilters.push('min_payout');
  }

  if (query.filters?.maxPayout !== undefined) {
    sql += ` AND t.hustler_payout_cents <= $${paramIndex}`;
    params.push(query.filters.maxPayout * 100);
    paramIndex++;
    appliedFilters.push('max_payout');
  }

  if (query.filters?.riskLevels && query.filters.riskLevels.length > 0) {
    sql += ` AND lower(t.risk_level) = ANY($${paramIndex})`;
    params.push(query.filters.riskLevels.map(level => level.toLowerCase()));
    paramIndex++;
    appliedFilters.push('risk_level');
  }
  appliedFilters.push('database_eligibility');

  if (query.location && query.radiusMiles) {
    sql += ` AND t.location_lat IS NOT NULL
      AND t.location_lng IS NOT NULL
      AND (
      3959 * acos(LEAST(1, GREATEST(-1,
        cos(radians($${paramIndex})) * cos(radians(t.location_lat)) *
        cos(radians(t.location_lng) - radians($${paramIndex + 1})) +
        sin(radians($${paramIndex})) * sin(radians(t.location_lat))
      )))
    ) <= $${paramIndex + 2}`;
    params.push(query.location.lat, query.location.lng, query.radiusMiles);
    paramIndex += 3;
    appliedFilters.push('location');
  }

  if (query.pagination.cursor) {
    sql += ` AND t.created_at < $${paramIndex}`;
    params.push(new Date(query.pagination.cursor));
    paramIndex++;
  }

  sql += ` ORDER BY t.created_at DESC, t.id DESC LIMIT $${paramIndex}`;
  params.push(Math.max(1, Math.min(query.pagination.limit, 50)));

  // Execute query
  const result = await db.query<TaskFeedRow>(sql, params);

  log.debug({ 
    userId: query.userId, 
    rawCount: result.rows.length,
    duration: Date.now() - startTime 
  }, 'Feed query executed');

  const tasks: FeedTask[] = result.rows.map((row) => {
    let distance: number | undefined;
    if (query.location && row.location_lat && row.location_lng) {
      distance = calculateDistance(
        query.location.lat,
        query.location.lng,
        row.location_lat,
        row.location_lng
      );
    }

    return {
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
        eligible: true,
        code: 'HX200',
        reasons: ['Authoritative SQL eligibility policy satisfied'],
      },
      distance,
    };
  });

  // Get next cursor from last task
  const nextCursor = tasks.length > 0 
    ? tasks[tasks.length - 1].postedAt 
    : undefined;

  log.info({ 
    userId: query.userId, 
    returnedCount: tasks.length,
    duration: Date.now() - startTime 
  }, 'Feed query completed');

  return {
    tasks,
    nextCursor,
    totalCount: tasks.length,
    filters: {
      applied: appliedFilters,
      excluded: 0,
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

/** Get actionable tasks near a location using the canonical feed authority. */
export async function getNearbyTasks(
  userId: string,
  capabilityProfile: CapabilityProfile,
  lat: number,
  lng: number,
  radiusMiles: number,
  limit: number = 20
): Promise<Array<{ id: string; title: string; lat: number; lng: number; payoutCents: number }>> {
  const result = await queryFeed({
    userId,
    capabilityProfile,
    location: { lat, lng },
    radiusMiles,
    pagination: { limit },
  });
  return result.tasks.map(task => ({
    id: task.id,
    title: task.title,
    lat: task.location.lat,
    lng: task.location.lng,
    payoutCents: task.payout.cents,
  }));
}

/** Get actionable tasks for a trade and state using the canonical feed authority. */
export async function getTasksByTrade(
  userId: string,
  capabilityProfile: CapabilityProfile,
  trade: string,
  state: string,
  limit: number = 20
): Promise<FeedTask[]> {
  const result = await queryFeed({
    userId,
    capabilityProfile,
    filters: { trades: [trade], states: [state] },
    pagination: { limit },
  });
  return result.tasks;
}

export default {
  queryFeed,
  getNearbyTasks,
  getTasksByTrade,
};
