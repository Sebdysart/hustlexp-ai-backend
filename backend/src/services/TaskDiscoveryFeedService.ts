import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { feedItemsForRows } from './TaskDiscoveryOfferService.js';
import {
  personalizedFeedQuery,
  publicFeedQuery,
  searchQuery,
} from './TaskDiscoveryQueryBuilder.js';
import { calculateFeedScores } from './TaskDiscoveryScoreService.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import type {
  FeedFilters,
  PublicFeedFilters,
  PublicTaskRow,
  SearchFilters,
  TaskFeedItem,
  TaskFeedRow,
} from './TaskDiscoveryTypes.js';

function databaseError(error: unknown): ServiceResult<never> {
  console.error('[TaskDiscoveryService] DB error:', error);
  return { success: false, error: { code: 'DB_ERROR', message: 'Database error' } };
}

/**
 * Defense in depth for pre-match responses. The SQL projection is already
 * allowlisted, but database views, mocks, or later query edits must not be able
 * to smuggle identity, protected-trait, or exact-location fields into a feed.
 */
function minimizePreMatchTaskRow(row: TaskFeedRow): TaskFeedRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    price: row.price,
    location: row.rough_location ?? null,
    deadline: row.deadline,
    created_at: row.created_at,
    state: row.state,
    requires_proof: row.requires_proof,
    mode: row.mode,
    hustler_payout_cents: row.hustler_payout_cents,
    estimated_duration_minutes: row.estimated_duration_minutes,
    rough_location: row.rough_location,
    risk_level: row.risk_level,
    required_tools: row.required_tools,
    requirements: row.requirements,
    scope_hash: row.scope_hash,
    cancellation_policy_version: row.cancellation_policy_version,
    late_cancel_pct: row.late_cancel_pct,
    cancellation_window_hours: row.cancellation_window_hours,
    minimum_provider_net_hourly_cents: row.minimum_provider_net_hourly_cents,
    provider_earnings_policy_version: row.provider_earnings_policy_version,
    matching_score: row.matching_score,
    relevance_score: row.relevance_score,
    distance_miles: row.distance_miles,
    search_rank: row.search_rank,
  };
}

export async function browsePublicFeed(
  filters: PublicFeedFilters,
  limit = 20,
  offset = 0
): Promise<ServiceResult<PublicTaskRow[]>> {
  try {
    const query = publicFeedQuery(filters, limit, offset);
    const result = await db.query<PublicTaskRow>(query.sql, query.params);
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseError(error);
  }
}

export async function getFeed(
  hustlerId: string,
  filters: FeedFilters = {},
  limit = 50,
  offset = 0
): Promise<ServiceResult<TaskFeedItem[]>> {
  try {
    await recomputeCapabilityProfile(hustlerId, { reason: 'task_discovery_feed' });
    const scores = await calculateFeedScores(hustlerId, filters.max_distance_miles || 10);
    if (!scores.success) return { success: false, error: scores.error };
    const query = personalizedFeedQuery(hustlerId, filters, limit, offset);
    const result = await db.query<TaskFeedRow>(query.sql, query.params);
    const feedItems = await feedItemsForRows(hustlerId, result.rows.map(minimizePreMatchTaskRow));
    return { success: true, data: feedItems };
  } catch (error) {
    return databaseError(error);
  }
}

export async function search(
  hustlerId: string,
  filters: SearchFilters,
  limit = 50,
  offset = 0
): Promise<ServiceResult<TaskFeedItem[]>> {
  if (!filters.query) return getFeed(hustlerId, filters, limit, offset);
  try {
    await recomputeCapabilityProfile(hustlerId, { reason: 'task_discovery_search' });
    const scores = await calculateFeedScores(hustlerId, filters.max_distance_miles || 10);
    if (!scores.success) return { success: false, error: scores.error };
    const query = searchQuery(hustlerId, filters, limit, offset);
    const result = await db.query<TaskFeedRow>(query.sql, query.params);
    const feedItems = await feedItemsForRows(hustlerId, result.rows.map(minimizePreMatchTaskRow));
    return { success: true, data: feedItems };
  } catch (error) {
    return databaseError(error);
  }
}
