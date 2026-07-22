import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { GeocodingService } from './GeocodingService.js';
import {
  categoryMatch,
  compositeMatchingScore,
  distanceScore,
  priceAttractiveness,
  relevanceScore,
  timeMatch,
  trustMultiplier,
} from './TaskDiscoveryScoring.js';
import type { MatchingScoreComponents } from './TaskDiscoveryTypes.js';
import { eligibleTaskCandidatesQuery } from './TaskDiscoveryQueryBuilder.js';

interface ScoreTask {
  id: string;
  category: string;
  price: number;
  deadline: Date | null;
  location: string | null;
  created_at: Date;
}

interface ScoreHustler {
  id: string;
  trust_tier: number;
  zip_code: string | null;
  preferred_categories: string[];
  preferred_min_price: number;
}

interface ScoreStats {
  completion_rate: number;
  approval_rate: number;
}

function databaseError(error: unknown): ServiceResult<never> {
  console.error('[TaskDiscoveryService] DB error:', error);
  return { success: false, error: { code: 'DB_ERROR', message: 'Database error' } };
}

async function loadTask(taskId: string): Promise<ServiceResult<ScoreTask>> {
  const result = await db.query<ScoreTask>(
    'SELECT id, category, price, deadline, location, created_at FROM tasks WHERE id = $1',
    [taskId],
  );
  if (result.rows[0]) return { success: true, data: result.rows[0] };
  return {
    success: false,
    error: { code: ErrorCodes.NOT_FOUND, message: `Task ${taskId} not found` },
  };
}

async function loadHustler(hustlerId: string): Promise<ServiceResult<ScoreHustler>> {
  const result = await db.query<ScoreHustler>(
    `SELECT
      id,
      trust_tier,
      NULLIF(CONCAT_WS(', ', location_city, location_state), '') AS zip_code,
      ARRAY[]::TEXT[] AS preferred_categories,
      0::INTEGER AS preferred_min_price
     FROM users WHERE id = $1`,
    [hustlerId],
  );
  if (result.rows[0]) return { success: true, data: result.rows[0] };
  return {
    success: false,
    error: { code: ErrorCodes.NOT_FOUND, message: `Hustler ${hustlerId} not found` },
  };
}

async function loadStats(hustlerId: string): Promise<ScoreStats> {
  const result = await db.query<ScoreStats>(
    `SELECT
      COUNT(*) FILTER (WHERE t.state = 'COMPLETED')::FLOAT /
        NULLIF(COUNT(*) FILTER (WHERE t.state IN ('ACCEPTED', 'COMPLETED', 'CANCELLED')), 0) * 100 as completion_rate,
      COUNT(*) FILTER (WHERE p.state = 'ACCEPTED')::FLOAT /
        NULLIF(COUNT(*) FILTER (WHERE p.state IS NOT NULL), 0) * 100 as approval_rate
     FROM tasks t
     LEFT JOIN proofs p ON p.task_id = t.id
     WHERE t.worker_id = $1`,
    [hustlerId],
  );
  return result.rows[0] || { completion_rate: 0, approval_rate: 0 };
}

async function loadCategoryExperience(hustlerId: string): Promise<Record<string, number>> {
  const result = await db.query<{ category: string; count: number }>(
    `SELECT category, COUNT(*) as count
     FROM tasks
     WHERE worker_id = $1 AND state = 'COMPLETED'
     GROUP BY category`,
    [hustlerId],
  );
  const experience: Record<string, number> = {};
  for (const row of result.rows) {
    experience[row.category || ''] = parseInt(String(row.count), 10);
  }
  return experience;
}

async function calculateDistance(task: ScoreTask, hustler: ScoreHustler): Promise<number> {
  try {
    const taskCoords = task.location
      ? await GeocodingService.geocodeAddress(task.location)
      : null;
    const hustlerCoords = hustler.zip_code
      ? await GeocodingService.geocodeAddress(hustler.zip_code)
      : null;
    if (!taskCoords || !hustlerCoords) return 0;
    return GeocodingService.calculateDistanceMiles(
      taskCoords.lat,
      taskCoords.lng,
      hustlerCoords.lat,
      hustlerCoords.lng,
    );
  } catch {
    return 0;
  }
}

function scoreComponents(
  task: ScoreTask,
  hustler: ScoreHustler,
  stats: ScoreStats,
  experience: Record<string, number>,
  distanceMiles: number,
): MatchingScoreComponents {
  return {
    trust_multiplier: trustMultiplier(
      hustler.trust_tier || 1,
      stats.completion_rate || 0,
      stats.approval_rate || 0,
    ),
    distance_score: distanceScore(distanceMiles),
    category_match: categoryMatch(
      task.category || '',
      hustler.preferred_categories || [],
      experience,
    ),
    price_attractiveness: priceAttractiveness(
      task.price,
      hustler.preferred_min_price || 0,
      task.price,
    ),
    time_match: timeMatch(task.deadline, 24),
  };
}

export async function calculateMatchingScore(
  taskId: string,
  hustlerId: string,
): Promise<ServiceResult<{
  matchingScore: number;
  components: MatchingScoreComponents;
  distanceMiles: number;
}>> {
  try {
    const task = await loadTask(taskId);
    if (!task.success) return task;
    const hustler = await loadHustler(hustlerId);
    if (!hustler.success) return hustler;
    const stats = await loadStats(hustlerId);
    const experience = await loadCategoryExperience(hustlerId);
    const distanceMiles = await calculateDistance(task.data, hustler.data);
    const components = scoreComponents(
      task.data,
      hustler.data,
      stats,
      experience,
      distanceMiles,
    );
    return {
      success: true,
      data: {
        matchingScore: compositeMatchingScore(components),
        components,
        distanceMiles,
      },
    };
  } catch (error) {
    return databaseError(error);
  }
}

async function cacheTaskScore(
  taskId: string,
  hustlerId: string,
  maxDistanceMiles: number,
  expiresAt: Date,
): Promise<'calculated' | 'skipped'> {
  const score = await calculateMatchingScore(taskId, hustlerId);
  if (!score.success || score.data.distanceMiles > maxDistanceMiles) return 'skipped';
  const taskDetails = await db.query<{ created_at: Date; deadline: Date | null }>(
    'SELECT created_at, deadline FROM tasks WHERE id = $1',
    [taskId],
  );
  if (taskDetails.rows.length === 0) return 'skipped';
  const relevance = relevanceScore(
    score.data.matchingScore,
    taskDetails.rows[0].created_at,
    taskDetails.rows[0].deadline,
  );
  try {
    await db.query(
      `INSERT INTO task_matching_scores (
        task_id, hustler_id, matching_score, relevance_score,
        distance_miles, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (task_id, hustler_id)
      DO UPDATE SET
        matching_score = EXCLUDED.matching_score,
        relevance_score = EXCLUDED.relevance_score,
        distance_miles = EXCLUDED.distance_miles,
        calculated_at = NOW(),
        expires_at = EXCLUDED.expires_at`,
      [
        taskId,
        hustlerId,
        score.data.matchingScore,
        relevance,
        score.data.distanceMiles,
        expiresAt,
      ],
    );
    return 'calculated';
  } catch {
    return 'skipped';
  }
}

export async function calculateFeedScores(
  hustlerId: string,
  maxDistanceMiles = 10,
): Promise<ServiceResult<{ calculated: number; cached: number }>> {
  try {
    const candidateQuery = eligibleTaskCandidatesQuery(hustlerId);
    const openTasks = await db.query<{ id: string }>(candidateQuery.sql, candidateQuery.params);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    let calculated = 0;
    let cached = 0;
    for (const task of openTasks.rows) {
      const result = await cacheTaskScore(task.id, hustlerId, maxDistanceMiles, expiresAt);
      if (result === 'skipped') continue;
      cached += 1;
      calculated += 1;
    }
    return { success: true, data: { calculated, cached } };
  } catch (error) {
    return databaseError(error);
  }
}
