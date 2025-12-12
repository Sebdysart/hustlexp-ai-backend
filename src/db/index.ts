import { neon, Pool } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

// Get database URL from environment
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    logger.warn('DATABASE_URL not set - using in-memory storage');
}

// Create SQL query function (uses HTTP by default which works everywhere)
export const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

// Create Pool for transactions (requires WebSocket)
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

/**
 * Execute a function within a transaction
 */
export async function transaction<T>(
    callback: (tx: any) => Promise<T>
): Promise<T> {
    if (!pool) {
        throw new Error('Database pool not configured');
    }

    const client = await pool.connect();
    try {
        // PHASE 6.1: Use SERIALIZABLE isolation for financial transactions
        // Prevents race conditions in concurrent payout attempts
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        // Create a compatibility wrapper for `tx` so it looks like `sql` tag function
        // because existing code uses `await tx`...`
        // Actually, existing code in StripeMoneyEngine uses `await tx`...` tag syntax.
        // We need to provide a `tx` object that is callable as a tag function OR has `query`.
        // The user code: `await tx`SELECT ...``.
        // To support this, we need to bind the neon-like interface to the pool client?
        // Or simply expose the client and change StripeMoneyEngine to use `await tx.query(...)`.
        // User code in StripeMoneyEngine: `const [lock] = await tx`SELECT...``
        // This implies `tx` IS a tagged template function.
        // We can simulate this or change StripeMoneyEngine.

        // Simulating tagged template on top of pg client:
        const txTag = async (strings: TemplateStringsArray, ...values: any[]) => {
            let text = strings[0];
            for (let i = 1; i < strings.length; i++) {
                text += '$' + i + strings[i];
            }
            const res = await client.query(text, values);
            return res.rows;
        };

        const result = await callback(txTag);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

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
