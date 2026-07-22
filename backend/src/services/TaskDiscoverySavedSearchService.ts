import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { search } from './TaskDiscoveryFeedService.js';
import type {
  SavedSearch,
  SearchFilters,
  TaskFeedItem,
} from './TaskDiscoveryTypes.js';

function databaseError(error: unknown): ServiceResult<never> {
  console.error('[TaskDiscoveryService] DB error:', error);
  return { success: false, error: { code: 'DB_ERROR', message: 'Database error' } };
}

function parsedSearch(searchRow: SavedSearch): SavedSearch {
  return {
    ...searchRow,
    filters: typeof searchRow.filters === 'string'
      ? JSON.parse(searchRow.filters)
      : searchRow.filters,
  };
}

export async function saveSearch(
  userId: string,
  name: string,
  query: string | undefined,
  filters: Record<string, unknown>,
  sortBy = 'relevance',
): Promise<ServiceResult<SavedSearch>> {
  try {
    const validSort = ['relevance', 'price', 'distance', 'deadline'].includes(sortBy)
      ? sortBy
      : 'relevance';
    const result = await db.query<SavedSearch>(
      `INSERT INTO saved_searches (user_id, name, query, filters, sort_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [userId, name, query || null, JSON.stringify(filters), validSort],
    );
    return { success: true, data: parsedSearch(result.rows[0]) };
  } catch (error) {
    return databaseError(error);
  }
}

export async function getSavedSearches(userId: string): Promise<ServiceResult<SavedSearch[]>> {
  try {
    const result = await db.query<SavedSearch>(
      `SELECT * FROM saved_searches
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return { success: true, data: result.rows.map(parsedSearch) };
  } catch (error) {
    return databaseError(error);
  }
}

export async function deleteSavedSearch(
  searchId: string,
  userId: string,
): Promise<ServiceResult<void>> {
  try {
    const result = await db.query(
      `DELETE FROM saved_searches
       WHERE id = $1 AND user_id = $2`,
      [searchId, userId],
    );
    if (result.rowCount !== 0) return { success: true, data: undefined };
    return {
      success: false,
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: 'Saved search not found or access denied',
      },
    };
  } catch (error) {
    return databaseError(error);
  }
}

export async function executeSavedSearch(
  searchId: string,
  userId: string,
  limit = 50,
  offset = 0,
): Promise<ServiceResult<TaskFeedItem[]>> {
  try {
    const result = await db.query<SavedSearch>(
      `SELECT * FROM saved_searches
       WHERE id = $1 AND user_id = $2`,
      [searchId, userId],
    );
    if (result.rows.length === 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: 'Saved search not found or access denied',
        },
      };
    }
    const savedSearch = parsedSearch(result.rows[0]);
    return search(
      userId,
      {
        query: savedSearch.query || undefined,
        ...(savedSearch.filters as Record<string, unknown>),
      } as SearchFilters,
      limit,
      offset,
    );
  } catch (error) {
    return databaseError(error);
  }
}
