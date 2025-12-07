import { neon } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

// Get database URL from environment
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    logger.warn('DATABASE_URL not set - using in-memory storage');
}

// Create SQL query function (uses HTTP by default which works everywhere)
export const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

/**
 * Execute a raw query with parameters
 */
export async function query<T>(
    queryText: string,
    params?: unknown[]
): Promise<T[]> {
    if (!sql) {
        throw new Error('Database not configured - set DATABASE_URL in .env');
    }

    try {
        const result = await sql(queryText, params);
        return result as T[];
    } catch (error) {
        logger.error({ error, query: queryText.slice(0, 100) }, 'Database query failed');
        throw error;
    }
}

/**
 * Check if database is available
 */
export function isDatabaseAvailable(): boolean {
    return sql !== null;
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
    if (!sql) return false;

    try {
        const result = await sql`SELECT 1 as connected`;
        if (result && result.length > 0) {
            logger.info('Database connection successful');
            return true;
        }
        return false;
    } catch (error) {
        logger.error({ error }, 'Database connection failed');
        return false;
    }
}

export const db = { sql, query, isDatabaseAvailable, testConnection };
