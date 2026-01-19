/**
 * HustleXP Database Client v1.0.0
 * 
 * CONSTITUTIONAL: Layer 0 - Highest Authority
 * 
 * Uses Neon PostgreSQL serverless driver.
 * Handles HustleXP-specific error codes from triggers.
 * 
 * @see schema.sql v1.0.0
 * @see ARCHITECTURE.md §1
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Enable WebSocket for Neon serverless
neonConfig.webSocketConstructor = ws;

// ============================================================================
// CONFIGURATION
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is required');
  throw new Error('DATABASE_URL environment variable is not set');
}

// ============================================================================
// CONNECTION POOL
// ============================================================================

// Disable prepared statements in test environment to avoid stale plan cache
// when schema changes during test execution
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Disable prepared statements in tests to prevent stale plan cache
  // when schema changes occur during test execution
  ...(isTestEnv && { 
    // Force re-planning by using a query that invalidates prepared statements
    // Neon serverless may not support prepareThreshold, so we'll handle it in query execution
  }),
});

console.log('✅ Neon database pool initialized');

// ============================================================================
// HUSTLEXP ERROR CODES
// ============================================================================

/**
 * HustleXP-specific error codes raised by database triggers.
 * These map to invariant violations.
 * 
 * @see PRODUCT_SPEC.md §10 (Error Codes)
 * @see schema.sql (Error code reference)
 */
export const HX_ERROR_CODES = {
  // Terminal state violations
  HX001: 'Task terminal state violation - Cannot modify task in COMPLETED/CANCELLED/EXPIRED state',
  HX002: 'Escrow terminal state violation - Cannot modify escrow in RELEASED/REFUNDED/REFUND_PARTIAL state',
  
  // INV-4: Escrow amount immutable
  HX004: 'INV-4 VIOLATION: Escrow amount cannot be modified after creation',
  
  // INV-1: XP requires RELEASED escrow
  HX101: 'INV-1 VIOLATION: Cannot award XP - escrow not in RELEASED state',
  HX102: 'XP ledger immutability violation - XP ledger entries cannot be deleted',
  
  // INV-2: RELEASED requires COMPLETED task
  HX201: 'INV-2 VIOLATION: Cannot release escrow - task not in COMPLETED state',
  
  // INV-3: COMPLETED requires ACCEPTED proof
  HX301: 'INV-3 VIOLATION: Cannot complete task - proof not in ACCEPTED state',
  
  // Badge system
  HX401: 'INV-BADGE-2 VIOLATION: Badge delete attempt - Badges are append-only',
  
  // Admin actions
  HX801: 'Admin action audit immutability - Admin action entries cannot be deleted',
  
  // Live Mode (HX9XX)
  HX901: 'LIVE-1 VIOLATION: Live broadcast without funded escrow',
  HX902: 'LIVE-2 VIOLATION: Live task below price floor ($15.00 minimum)',
  HX903: 'Hustler not in ACTIVE live mode state',
  HX904: 'Live Mode toggle cooldown violation',
  HX905: 'Live Mode banned - Cannot enable while banned',
  
  // Human Systems (HX6XX) - Reserved for future enforcement
  HX601: 'Fatigue mandatory break bypass attempt',
  HX602: 'Pause state violation',
  HX603: 'Poster reputation access by poster (POSTER-1 violation)',
  HX604: 'Percentile public exposure attempt (PERC-1 violation)',
} as const;

export type HXErrorCode = keyof typeof HX_ERROR_CODES;

// ============================================================================
// ERROR HANDLING
// ============================================================================

export interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  schema?: string;
  table?: string;
  column?: string;
}

/**
 * Check if error is a HustleXP invariant violation
 * PostgreSQL custom error codes are set via ERRCODE in triggers
 */
export function isInvariantViolation(error: unknown): error is DatabaseError {
  if (!(error instanceof Error)) return false;
  const dbError = error as DatabaseError;
  if (!dbError.code) return false;
  
  // Check if it's an HX error code (HX001, HX002, etc.)
  const hxCodePattern = /^HX\d{3}$/;
  if (hxCodePattern.test(dbError.code)) {
    return dbError.code in HX_ERROR_CODES;
  }
  
  return false;
}

/**
 * Get the HX error code from an error, if present
 */
export function getHXErrorCode(error: unknown): HXErrorCode | null {
  if (!isInvariantViolation(error)) return null;
  return error.code as HXErrorCode;
}

/**
 * Helper: Check if error is INV-1 violation (XP requires RELEASED escrow)
 */
export function isInv1Violation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX101';
}

/**
 * Helper: Check if error is INV-2 violation (RELEASED requires COMPLETED task)
 */
export function isInv2Violation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX201';
}

/**
 * Helper: Check if error is INV-3 violation (COMPLETED requires ACCEPTED proof)
 */
export function isInv3Violation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX301';
}

/**
 * Helper: Check if error is INV-4 violation (Escrow amount immutable)
 */
export function isInv4Violation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX004';
}

/**
 * Helper: Check if error is terminal state violation (task)
 */
export function isTaskTerminalViolation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX001';
}

/**
 * Helper: Check if error is terminal state violation (escrow)
 */
export function isEscrowTerminalViolation(error: unknown): boolean {
  return getHXErrorCode(error) === 'HX002';
}

/**
 * Helper: Check if error is Live Mode violation
 */
export function isLiveModeViolation(error: unknown): boolean {
  const code = getHXErrorCode(error);
  return code !== null && ['HX901', 'HX902', 'HX903', 'HX904', 'HX905'].includes(code);
}

/**
 * Check if error is a unique constraint violation (INV-5)
 */
export function isUniqueViolation(error: unknown): error is DatabaseError {
  if (!(error instanceof Error)) return false;
  const dbError = error as DatabaseError;
  return dbError.code === '23505';
}

/**
 * Get human-readable message for HustleXP error code
 */
export function getErrorMessage(code: string): string {
  return HX_ERROR_CODES[code as HXErrorCode] || `Unknown error: ${code}`;
}

// ============================================================================
// QUERY INTERFACE
// ============================================================================

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export const db = {
  /**
   * Execute a SQL query
   */
  query: async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> => {
    const client = await pool.connect();
    try {
      // In test environment, clear prepared statement cache before each query
      // This prevents stale plans when schema changes during test execution
      if (isTestEnv) {
        // Clear all prepared statements on this connection
        // This ensures fresh planning for each query in tests
        try {
          await client.query('DEALLOCATE ALL');
        } catch {
          // Ignore errors - connection may not have prepared statements yet
        }
      }
      const result = await client.query(sql, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0,
      };
    } finally {
      client.release();
    }
  },

  /**
   * Execute queries within a transaction
   */
  transaction: async <T>(
    fn: (query: typeof db.query) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const txQuery = async <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> => {
        const result = await client.query(sql, params);
        return {
          rows: result.rows as R[],
          rowCount: result.rowCount ?? 0,
        };
      };
      
      const result = await fn(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[DB] ROLLBACK failed - original error may be lost', {
          originalError: error,
          rollbackError,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Execute queries within a SERIALIZABLE transaction
   * Use for critical invariant operations
   */
  serializableTransaction: async <T>(
    fn: (query: typeof db.query) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      
      const txQuery = async <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> => {
        const result = await client.query(sql, params);
        return {
          rows: result.rows as R[],
          rowCount: result.rowCount ?? 0,
        };
      };
      
      const result = await fn(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[DB] ROLLBACK failed - original error may be lost', {
          originalError: error,
          rollbackError,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Health check - verify database connection and schema version
   */
  healthCheck: async (): Promise<{
    connected: boolean;
    schemaVersion: string | null;
    latencyMs: number;
  }> => {
    const start = Date.now();
    try {
      const result = await db.query<{ version: string }>(
        'SELECT version FROM schema_versions ORDER BY applied_at DESC LIMIT 1'
      );
      return {
        connected: true,
        schemaVersion: result.rows[0]?.version ?? null,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        connected: false,
        schemaVersion: null,
        latencyMs: Date.now() - start,
      };
    }
  },

  /**
   * Get underlying pool for advanced usage
   */
  getPool: () => pool,

  /**
   * Close all connections (for graceful shutdown)
   */
  close: async () => {
    await pool.end();
    console.log('✅ Database pool closed');
  },
};

// ============================================================================
// HEALTH CHECK (Extended)
// ============================================================================

export async function checkHealth(): Promise<{
  database: boolean;
  schemaVersion: string | null;
  triggers: number;
  latencyMs: number;
}> {
  const start = Date.now();
  try {
    // Check schema version
    const versionResult = await db.query<{ version: string }>(
      'SELECT version FROM schema_versions ORDER BY applied_at DESC LIMIT 1'
    );
    
    // Count triggers
    const triggerResult = await db.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM information_schema.triggers WHERE trigger_schema = 'public'"
    );
    
    return {
      database: true,
      schemaVersion: versionResult.rows[0]?.version ?? null,
      triggers: parseInt(triggerResult.rows[0]?.count ?? '0', 10),
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    console.error('[DB] Health check failed:', error);
    return {
      database: false,
      schemaVersion: null,
      triggers: 0,
      latencyMs: Date.now() - start,
    };
  }
}

export default db;
