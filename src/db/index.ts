
import { neon, Pool } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

// Get database URL from environment
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    // logger.warn('DATABASE_URL not set'); // Handled below
}

// Create SQL query function (uses HTTP by default which works everywhere)
export const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

if (DATABASE_URL) {
    // Mask the secret parts for logging
    const maskedUrl = DATABASE_URL.replace(/:[^:@]+@/, ':***@');
    logger.info({ url: maskedUrl }, 'Initializing Neon Database Connection');
} else {
    logger.error('CRITICAL: DATABASE_URL is not set. Database features will fail.');
}

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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:36',message:'Transaction started - client connected',data:{hasPool:!!pool},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    try {
        // PHASE 6.1: Use SERIALIZABLE isolation for financial transactions
        // Prevents race conditions in concurrent payout attempts
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:42',message:'BEGIN transaction executed',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion

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
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:53',message:'Callback completed, attempting COMMIT',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        await client.query('COMMIT');
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:54',message:'COMMIT succeeded',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        return result;
    } catch (e) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:57',message:'Error caught in transaction',data:{errorMessage:e instanceof Error?e.message:String(e),errorType:e?.constructor?.name},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        try {
            await client.query('ROLLBACK');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:59',message:'ROLLBACK succeeded',data:{originalError:e instanceof Error?e.message:String(e)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
        } catch (rollbackError) {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:62',message:'ROLLBACK FAILED - original error may be lost',data:{originalError:e instanceof Error?e.message:String(e),rollbackError:rollbackError instanceof Error?rollbackError.message:String(rollbackError)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            logger.error({ originalError: e, rollbackError }, 'ROLLBACK failed - original error may be lost');
        }
        throw e;
    } finally {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/60a3436b-9cd6-40ea-918b-82324577294f',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/db/index.ts:69',message:'Releasing client connection',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
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
        // Fix: Use .query() for parameterized calls as strictly enforced by newer neon driver
        const result = await (sql as any).query(queryText, params);
        return result as T[];
    } catch (error) {
        if (error instanceof Error) {
            logger.error({ message: error.message, stack: error.stack, query: queryText.slice(0, 100) }, 'Database query failed');
        } else {
            logger.error({ error, query: queryText.slice(0, 100) }, 'Database query failed');
        }
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

// Non-null sql accessor - throws if not configured
// Use this in files that require database access
export function getSql() {
    if (!sql) {
        throw new Error('Database not configured - set DATABASE_URL');
    }
    return sql;
}

// Type assertion helper - for files that check null themselves
export const safeSql = sql!;

