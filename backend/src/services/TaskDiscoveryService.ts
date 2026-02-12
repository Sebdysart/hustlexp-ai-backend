/**
 * TaskDiscoveryService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §9, TASK_DISCOVERY_SPEC.md
 * 
 * Implements the task discovery and matching algorithm that connects
 * hustlers with relevant tasks based on trust, distance, category, price, and time.
 * 
 * Core Principle: Task discovery is not a feed. It is a personalized matching engine.
 * 
 * @see schema.sql §11.1 (task_matching_scores, saved_searches tables)
 * @see PRODUCT_SPEC.md §9
 * @see staging/TASK_DISCOVERY_SPEC.md
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { GeocodingService } from './GeocodingService';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskMatchingScore {
  id: string;
  task_id: string;
  hustler_id: string;
  matching_score: number; // 0.0 to 1.0
  relevance_score: number; // 0.0 to 1.0
  distance_miles: number;
  calculated_at: Date;
  expires_at: Date;
}

export interface MatchingScoreComponents {
  trust_multiplier: number;
  distance_score: number;
  category_match: number;
  price_attractiveness: number;
  time_match: number;
}

export interface TaskFeedItem {
  task: any; // Task type from types.ts
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  explanation: string; // "Why this task?" explanation
}

export interface SavedSearch {
  id: string;
  user_id: string;
  name: string;
  query: string | null;
  filters: Record<string, unknown> | string; // JSONB - can be string or object
  sort_by: string;
  created_at: Date;
}

export interface FeedFilters {
  category?: string;
  min_price?: number; // USD cents
  max_price?: number; // USD cents
  max_distance_miles?: number;
  min_matching_score?: number; // 0.0 to 1.0
  sort_by?: 'relevance' | 'price' | 'distance' | 'deadline';
}

export interface SearchFilters extends FeedFilters {
  query?: string; // Full-text search
}

// ============================================================================
// MATCHING SCORE CALCULATION (TASK_DISCOVERY_SPEC.md §1)
// ============================================================================

/**
 * Calculate matching score components
 * Formula: matching_score = (trust × 0.30 + distance × 0.25 + category × 0.20 + price × 0.15 + time × 0.10)
 */
function calculateMatchingScore(
  components: MatchingScoreComponents
): number {
  const score = (
    components.trust_multiplier * 0.30 +
    components.distance_score * 0.25 +
    components.category_match * 0.20 +
    components.price_attractiveness * 0.15 +
    components.time_match * 0.10
  );
  
  // Clamp to 0.0-1.0
  return Math.max(0.0, Math.min(1.0, score));
}

/**
 * Calculate trust multiplier (TASK_DISCOVERY_SPEC.md §1.2.1)
 * Formula: (trust_tier / 4.0) × 0.60 + (completion_rate / 100) × 0.30 + (approval_rate / 100) × 0.10
 */
function calculateTrustMultiplier(
  trustTier: number, // 1-4 (ROOKIE=1, VERIFIED=2, TRUSTED=3, ELITE=4)
  completionRate: number, // 0-100
  approvalRate: number // 0-100
): number {
  const tierComponent = (trustTier / 4.0) * 0.60;
  const completionComponent = (completionRate / 100) * 0.30;
  const approvalComponent = (approvalRate / 100) * 0.10;
  
  return tierComponent + completionComponent + approvalComponent;
}

/**
 * Calculate distance score (TASK_DISCOVERY_SPEC.md §1.2.2)
 */
function calculateDistanceScore(distanceMiles: number): number {
  if (distanceMiles <= 1.0) {
    return 1.0; // Excellent
  } else if (distanceMiles <= 3.0) {
    return 1.0 - ((distanceMiles - 1.0) / 2.0) * 0.3; // 1.0 to 0.7
  } else if (distanceMiles <= 5.0) {
    return 0.7 - ((distanceMiles - 3.0) / 2.0) * 0.4; // 0.7 to 0.3
  } else if (distanceMiles <= 10.0) {
    return 0.3 - ((distanceMiles - 5.0) / 5.0) * 0.2; // 0.3 to 0.1
  } else {
    return 0.0; // Too far
  }
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate category match (TASK_DISCOVERY_SPEC.md §1.2.3)
 */
function calculateCategoryMatch(
  taskCategory: string,
  preferredCategories: string[],
  categoryExperienceCount: Record<string, number>
): number {
  const isPreferred = preferredCategories.includes(taskCategory) ? 1.0 : 0.6;
  const experience = Math.min((categoryExperienceCount[taskCategory] || 0) / 10.0, 1.0);
  
  return (isPreferred * 0.70) + (experience * 0.30);
}

/**
 * Calculate price attractiveness (TASK_DISCOVERY_SPEC.md §1.2.4)
 */
function calculatePriceAttractiveness(
  taskPrice: number, // USD cents
  preferredMinPrice: number, // USD cents
  marketAverage: number // USD cents
): number {
  const meetsMinimum = taskPrice >= preferredMinPrice ? 1.0 : 0.5;
  const aboveMarket = taskPrice >= marketAverage ? 1.0 : 0.7;
  
  return (meetsMinimum * 0.60) + (aboveMarket * 0.40);
}

/**
 * Calculate time match (TASK_DISCOVERY_SPEC.md §1.2.5)
 */
function calculateTimeMatch(
  deadline: Date | null,
  availableWindowHours: number
): number {
  if (!deadline) {
    return 0.5; // Neutral if no deadline
  }
  
  const timeUntilDeadline = (deadline.getTime() - Date.now()) / (1000 * 60 * 60); // hours
  
  if (timeUntilDeadline >= availableWindowHours) {
    return 1.0; // Perfect timing
  } else if (timeUntilDeadline >= availableWindowHours * 0.5) {
    return 0.7; // Tight but doable
  } else {
    return 0.3; // Very tight
  }
}

/**
 * Calculate relevance score (TASK_DISCOVERY_SPEC.md §2)
 * Relevance = matching_score × freshness_factor × urgency_factor
 */
function calculateRelevanceScore(
  matchingScore: number,
  createdAt: Date,
  deadline: Date | null
): number {
  // Freshness factor: decay over 7 days
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
  const freshnessFactor = Math.max(0.5, 1.0 - (ageHours / (7 * 24)) * 0.5);
  
  // Urgency factor: boost for tasks with deadlines within 24 hours
  let urgencyFactor = 1.0;
  if (deadline) {
    const hoursUntilDeadline = (deadline.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilDeadline < 24 && hoursUntilDeadline > 0) {
      urgencyFactor = 1.2; // 20% boost for urgent tasks
    }
  }
  
  return matchingScore * freshnessFactor * urgencyFactor;
}

// ============================================================================
// SERVICE
// ============================================================================

export const TaskDiscoveryService = {
  // --------------------------------------------------------------------------
  // MATCHING SCORE CALCULATION
  // --------------------------------------------------------------------------
  
  /**
   * Calculate matching score for a task-hustler pair
   * 
   * This is the core matching algorithm from TASK_DISCOVERY_SPEC.md §1
   */
  calculateMatchingScore: async (
    taskId: string,
    hustlerId: string
  ): Promise<ServiceResult<{ matchingScore: number; components: MatchingScoreComponents; distanceMiles: number }>> => {
    try {
      // Get task details
      const taskResult = await db.query<{
        id: string;
        category: string;
        price: number;
        deadline: Date | null;
        location: string | null;
        created_at: Date;
      }>(
        'SELECT id, category, price, deadline, location, created_at FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      const task = taskResult.rows[0];
      
      // Get hustler details
      const hustlerResult = await db.query<{
        id: string;
        trust_tier: number;
        zip_code: string | null;
        preferred_categories: string[];
        preferred_min_price: number;
      }>(
        `SELECT 
          id, 
          trust_tier, 
          zip_code,
          COALESCE(preferred_categories, ARRAY[]::TEXT[]) as preferred_categories,
          COALESCE(preferred_min_price, 0) as preferred_min_price
        FROM users WHERE id = $1`,
        [hustlerId]
      );
      
      if (hustlerResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Hustler ${hustlerId} not found`,
          },
        };
      }
      
      const hustler = hustlerResult.rows[0];
      
      // Get hustler stats for trust calculation
      const statsResult = await db.query<{
        completion_rate: number;
        approval_rate: number;
        category_experience: Record<string, number>;
      }>(
        `SELECT 
          COUNT(*) FILTER (WHERE state = 'COMPLETED')::FLOAT / 
            NULLIF(COUNT(*) FILTER (WHERE state IN ('ACCEPTED', 'COMPLETED', 'CANCELLED')), 0) * 100 as completion_rate,
          COUNT(*) FILTER (WHERE p.state = 'ACCEPTED')::FLOAT / 
            NULLIF(COUNT(*) FILTER (WHERE p.state IS NOT NULL), 0) * 100 as approval_rate
        FROM tasks t
        LEFT JOIN proofs p ON p.task_id = t.id
        WHERE t.worker_id = $1`,
        [hustlerId]
      );
      
      const stats = statsResult.rows[0] || { completion_rate: 0, approval_rate: 0 };
      
      // Get category experience
      const categoryExpResult = await db.query<{ category: string; count: number }>(
        `SELECT category, COUNT(*) as count
         FROM tasks
         WHERE worker_id = $1 AND state = 'COMPLETED'
         GROUP BY category`,
        [hustlerId]
      );
      
      const categoryExperience: Record<string, number> = {};
      categoryExpResult.rows.forEach(row => {
        categoryExperience[row.category || ''] = parseInt(row.count as any, 10);
      });
      
      // Calculate distance using GeocodingService
      let distanceMiles = 0;
      try {
        // Geocode the task location (string -> coordinates, cached in Redis)
        const taskCoords = task.location
          ? await GeocodingService.geocodeAddress(task.location)
          : null;

        // Geocode the hustler's zip code (string -> coordinates, cached in Redis)
        const hustlerCoords = hustler.zip_code
          ? await GeocodingService.geocodeAddress(hustler.zip_code)
          : null;

        if (taskCoords && hustlerCoords) {
          distanceMiles = GeocodingService.calculateDistanceMiles(
            taskCoords.lat,
            taskCoords.lng,
            hustlerCoords.lat,
            hustlerCoords.lng
          );
        }
        // If either geocode fails, distanceMiles stays 0 (same as previous fallback)
      } catch {
        // Geocoding failure is non-critical; fall back to 0 distance
      }
      
      // Calculate components
      const trustMultiplier = calculateTrustMultiplier(
        hustler.trust_tier || 1,
        stats.completion_rate || 0,
        stats.approval_rate || 0
      );
      
      const distanceScore = calculateDistanceScore(distanceMiles);
      
      const categoryMatch = calculateCategoryMatch(
        task.category || '',
        hustler.preferred_categories || [],
        categoryExperience
      );
      
      // Get market average for category (placeholder - need market data)
      const marketAverage = task.price; // Placeholder
      const priceAttractiveness = calculatePriceAttractiveness(
        task.price,
        hustler.preferred_min_price || 0,
        marketAverage
      );
      
      // Calculate available window (placeholder - need availability data)
      const availableWindowHours = 24; // Placeholder
      const timeMatch = calculateTimeMatch(task.deadline, availableWindowHours);
      
      const components: MatchingScoreComponents = {
        trust_multiplier: trustMultiplier,
        distance_score: distanceScore,
        category_match: categoryMatch,
        price_attractiveness: priceAttractiveness,
        time_match: timeMatch,
      };
      
      const matchingScore = calculateMatchingScore(components);
      
      return {
        success: true,
        data: {
          matchingScore,
          components,
          distanceMiles,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Calculate and cache matching scores for a hustler's feed
   * 
   * This calculates scores for all open tasks and stores them in task_matching_scores table
   * with expiration (TASK_DISCOVERY_SPEC.md §3.2)
   */
  calculateFeedScores: async (
    hustlerId: string,
    maxDistanceMiles: number = 10.0
  ): Promise<ServiceResult<{ calculated: number; cached: number }>> => {
    try {
      // Get all open tasks
      const openTasks = await db.query<{ id: string }>(
        "SELECT id FROM tasks WHERE state = 'OPEN'"
      );
      
      let calculated = 0;
      let cached = 0;
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiration
      
      // Calculate scores for each task
      for (const task of openTasks.rows) {
        const scoreResult = await TaskDiscoveryService.calculateMatchingScore(task.id, hustlerId);
        
        if (!scoreResult.success) {
          continue;
        }
        
        const { matchingScore, components, distanceMiles } = scoreResult.data;
        
        // Skip tasks beyond max distance
        if (distanceMiles > maxDistanceMiles) {
          continue;
        }
        
        // Calculate relevance score
        const taskDetails = await db.query<{ created_at: Date; deadline: Date | null }>(
          'SELECT created_at, deadline FROM tasks WHERE id = $1',
          [task.id]
        );
        
        if (taskDetails.rows.length === 0) {
          continue;
        }
        
        const relevanceScore = calculateRelevanceScore(
          matchingScore,
          taskDetails.rows[0].created_at,
          taskDetails.rows[0].deadline
        );
        
        // Store or update cached score
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
            [task.id, hustlerId, matchingScore, relevanceScore, distanceMiles, expiresAt]
          );
          cached++;
        } catch (error) {
          // Skip if insert fails (e.g., constraint violation)
          continue;
        }
        
        calculated++;
      }
      
      return {
        success: true,
        data: { calculated, cached },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // TASK FEED GENERATION
  // --------------------------------------------------------------------------
  
  /**
   * Get personalized task feed for a hustler
   * 
   * Returns tasks ordered by relevance_score (TASK_DISCOVERY_SPEC.md §2)
   */
  getFeed: async (
    hustlerId: string,
    filters: FeedFilters = {},
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<TaskFeedItem[]>> => {
    try {
      // Ensure scores are calculated (or use cached if fresh)
      await TaskDiscoveryService.calculateFeedScores(hustlerId, filters.max_distance_miles || 10.0);
      
      // Build query
      let sql = `
        SELECT 
          t.*,
          tms.matching_score,
          tms.relevance_score,
          tms.distance_miles
        FROM tasks t
        INNER JOIN task_matching_scores tms ON tms.task_id = t.id AND tms.hustler_id = $1
        WHERE t.state = 'OPEN'
          AND tms.expires_at > NOW()
      `;
      
      const params: unknown[] = [hustlerId];
      
      // Apply filters
      if (filters.category) {
        params.push(filters.category);
        sql += ` AND t.category = $${params.length}`;
      }
      
      if (filters.min_price !== undefined) {
        params.push(filters.min_price);
        sql += ` AND t.price >= $${params.length}`;
      }
      
      if (filters.max_price !== undefined) {
        params.push(filters.max_price);
        sql += ` AND t.price <= $${params.length}`;
      }
      
      if (filters.max_distance_miles !== undefined) {
        params.push(filters.max_distance_miles);
        sql += ` AND tms.distance_miles <= $${params.length}`;
      }
      
      if (filters.min_matching_score !== undefined) {
        params.push(filters.min_matching_score);
        sql += ` AND tms.matching_score >= $${params.length}`;
      } else {
        // Default: hide tasks below 0.20 matching score (TASK_DISCOVERY_SPEC.md §1.3)
        sql += ` AND tms.matching_score >= 0.20`;
      }
      
      // Apply sorting
      const sortBy = filters.sort_by || 'relevance';
      switch (sortBy) {
        case 'relevance':
          sql += ` ORDER BY tms.relevance_score DESC`;
          break;
        case 'price':
          sql += ` ORDER BY t.price DESC`;
          break;
        case 'distance':
          sql += ` ORDER BY tms.distance_miles ASC`;
          break;
        case 'deadline':
          sql += ` ORDER BY t.deadline ASC NULLS LAST`;
          break;
        default:
          sql += ` ORDER BY tms.relevance_score DESC`;
      }
      
      params.push(limit, offset);
      sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
      
      const result = await db.query<any>(sql, params);
      
      // Generate "Why this task?" explanations (TASK_DISCOVERY_SPEC.md §4)
      const feedItems: TaskFeedItem[] = result.rows.map((row: any) => {
        const explanation = generateExplanation({
          matching_score: row.matching_score,
          distance_miles: row.distance_miles,
          category: row.category,
          price: row.price,
        });
        
        return {
          task: row,
          matching_score: row.matching_score,
          relevance_score: row.relevance_score,
          distance_miles: row.distance_miles,
          explanation,
        };
      });
      
      return {
        success: true,
        data: feedItems,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Search tasks with full-text search and filters
   * 
   * TASK_DISCOVERY_SPEC.md §5
   */
  search: async (
    hustlerId: string,
    searchFilters: SearchFilters,
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<TaskFeedItem[]>> => {
    try {
      // If query provided, use full-text search
      if (searchFilters.query) {
        // Use PostgreSQL full-text search
        let sql = `
          SELECT 
            t.*,
            COALESCE(tms.matching_score, 0.5) as matching_score,
            COALESCE(tms.relevance_score, 0.5) as relevance_score,
            COALESCE(tms.distance_miles, 999) as distance_miles,
            ts_rank(to_tsvector('english', t.title || ' ' || COALESCE(t.description, '')), plainto_tsquery('english', $1)) as search_rank
          FROM tasks t
          LEFT JOIN task_matching_scores tms ON tms.task_id = t.id AND tms.hustler_id = $2 AND tms.expires_at > NOW()
          WHERE t.state = 'OPEN'
            AND (
              to_tsvector('english', t.title || ' ' || COALESCE(t.description, '')) @@ plainto_tsquery('english', $1)
            )
        `;
        
        const params: unknown[] = [searchFilters.query, hustlerId];
        
        // Apply filters (same as getFeed)
        if (searchFilters.category) {
          params.push(searchFilters.category);
          sql += ` AND t.category = $${params.length}`;
        }
        
        // ... (apply other filters)
        
        sql += ` ORDER BY search_rank DESC, COALESCE(tms.relevance_score, 0.5) DESC`;
        
        params.push(limit, offset);
        sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
        
        const result = await db.query<any>(sql, params);
        
        const feedItems: TaskFeedItem[] = result.rows.map((row: any) => ({
          task: row,
          matching_score: row.matching_score,
          relevance_score: row.relevance_score,
          distance_miles: row.distance_miles,
          explanation: generateExplanation({
            matching_score: row.matching_score,
            distance_miles: row.distance_miles,
            category: row.category,
            price: row.price,
          }),
        }));
        
        return {
          success: true,
          data: feedItems,
        };
      } else {
        // No query - use regular feed with filters
        return TaskDiscoveryService.getFeed(hustlerId, searchFilters, limit, offset);
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get "Why this task?" explanation (TASK_DISCOVERY_SPEC.md §4)
   * 
   * AI-generated explanation (A1 authority - advisory only)
   */
  getExplanation: async (
    taskId: string,
    hustlerId: string
  ): Promise<ServiceResult<string>> => {
    try {
      // For now, return a simple explanation based on matching score
      // TODO: Integrate with AI service for richer explanations
      const scoreResult = await TaskDiscoveryService.calculateMatchingScore(taskId, hustlerId);
      
      if (!scoreResult.success) {
        return scoreResult;
      }
      
      const explanation = generateExplanation({
        matching_score: scoreResult.data.matchingScore,
        distance_miles: scoreResult.data.distanceMiles,
        category: '', // TODO: Get from task
        price: 0, // TODO: Get from task
      });
      
      return {
        success: true,
        data: explanation,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // SAVED SEARCHES (PRODUCT_SPEC §9.4)
  // --------------------------------------------------------------------------
  
  /**
   * Save a search query for quick access (PRODUCT_SPEC §9.4)
   */
  saveSearch: async (
    userId: string,
    name: string,
    query: string | undefined,
    filters: Record<string, unknown>,
    sortBy: string = 'relevance'
  ): Promise<ServiceResult<SavedSearch>> => {
    try {
      // Validate sort_by
      const validSortBy = ['relevance', 'price', 'distance', 'deadline'].includes(sortBy) 
        ? sortBy 
        : 'relevance';
      
      const result = await db.query<SavedSearch>(
        `INSERT INTO saved_searches (user_id, name, query, filters, sort_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING *`,
        [
          userId,
          name,
          query || null,
          JSON.stringify(filters),
          validSortBy,
        ]
      );
      
      // Parse JSONB filters for response
      const savedSearch = result.rows[0];
      const parsedFilters = typeof savedSearch.filters === 'string' 
        ? JSON.parse(savedSearch.filters) 
        : savedSearch.filters;
      
      return { 
        success: true, 
        data: {
          ...savedSearch,
          filters: parsedFilters,
        }
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get all saved searches for a user
   */
  getSavedSearches: async (
    userId: string
  ): Promise<ServiceResult<SavedSearch[]>> => {
    try {
      const result = await db.query<SavedSearch>(
        `SELECT * FROM saved_searches
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      );
      
      // Parse JSONB filters
      const searches = result.rows.map(row => ({
        ...row,
        filters: typeof row.filters === 'string' 
          ? JSON.parse(row.filters) 
          : row.filters,
      }));
      
      return { success: true, data: searches };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Delete a saved search
   */
  deleteSavedSearch: async (
    searchId: string,
    userId: string
  ): Promise<ServiceResult<void>> => {
    try {
      const result = await db.query(
        `DELETE FROM saved_searches
         WHERE id = $1 AND user_id = $2`,
        [searchId, userId]
      );
      
      if (result.rowCount === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: 'Saved search not found or access denied',
          },
        };
      }
      
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Execute a saved search (run the search with saved filters)
   */
  executeSavedSearch: async (
    searchId: string,
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<TaskFeedItem[]>> => {
    try {
      // Get saved search
      const searchResult = await db.query<SavedSearch>(
        `SELECT * FROM saved_searches
         WHERE id = $1 AND user_id = $2`,
        [searchId, userId]
      );
      
      if (searchResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: 'Saved search not found or access denied',
          },
        };
      }
      
      const savedSearch = searchResult.rows[0];
      const filters = typeof savedSearch.filters === 'string'
        ? JSON.parse(savedSearch.filters)
        : savedSearch.filters;
      
      // Execute search with saved filters
      return await TaskDiscoveryService.search(
        userId,
        {
          query: savedSearch.query || undefined,
          ...filters,
        } as SearchFilters,
        limit,
        offset
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate simple explanation (placeholder - should use AI service)
 */
function generateExplanation(context: {
  matching_score: number;
  distance_miles: number;
  category: string;
  price: number;
}): string {
  if (context.matching_score >= 0.80) {
    return 'Perfect match: High trust, close distance, preferred category.';
  } else if (context.matching_score >= 0.60) {
    return 'Great match: Good alignment with your profile and preferences.';
  } else if (context.matching_score >= 0.40) {
    return 'Good match: Reasonable fit for your skills and location.';
  } else {
    return 'Possible match: May require extra effort, but could be worth it.';
  }
}
