/**
 * HustleXP Database Client v1.0.0
 *
 * CONSTITUTIONAL: Layer 0 - Highest Authority
 *
 * Uses the standard pg driver (Railway PostgreSQL in production).
 * Handles HustleXP-specific error codes from triggers.
 *
 * @see ../database/constitutional-schema.sql
 */

import type { QueryFn, QueryResult } from './database-contracts.js';
import {
  runtimeDatabaseDataPlaneAuthorityHealth,
  type RuntimeDatabaseDataPlane,
  type RuntimeDatabaseDataPlanePoolStats,
} from './jobs/runtime-database-data-plane.js';
import { logger } from './logger.js';
const dbLog = logger.child({ module: 'db' });

/**
 * Configuration presence is diagnostic only. It is never database authority:
 * the stable facade remains unusable until startup installs an attested,
 * exact-target runtime data plane.
 */
export const hasDb = Boolean(process.env.DATABASE_URL?.trim());

export interface DatabaseRuntime {
  query: QueryFn;
  readQuery: QueryFn;
  transaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>;
  readOnlyAttestationTransaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>;
  serializableTransaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>;
  stats(): RuntimeDatabaseDataPlanePoolStats;
  close(): Promise<void>;
}

let installedRuntime: DatabaseRuntime | null = null;
let installedAuthorityDigest: string | null = null;

function unavailable(): never {
  throw new Error('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED');
}

function runtime(): DatabaseRuntime {
  return installedRuntime ?? unavailable();
}

/** Install exactly one still-live, module-issued canonical data plane. */
export function installAttestedDatabaseRuntime(plane: RuntimeDatabaseDataPlane): void {
  if (installedRuntime) throw new Error('DATABASE_RUNTIME_ALREADY_INSTALLED');
  const authority = runtimeDatabaseDataPlaneAuthorityHealth(plane);
  installedRuntime = Object.freeze({
    query: plane.query.bind(plane) as QueryFn,
    readQuery: plane.readQuery.bind(plane) as QueryFn,
    transaction: plane.transaction.bind(plane) as DatabaseRuntime['transaction'],
    readOnlyAttestationTransaction: plane.readOnlyAttestationTransaction.bind(
      plane
    ) as DatabaseRuntime['readOnlyAttestationTransaction'],
    serializableTransaction: plane.serializableTransaction.bind(
      plane
    ) as DatabaseRuntime['serializableTransaction'],
    stats: () => plane.stats(),
    close: () => plane.close(),
  });
  installedAuthorityDigest = authority.authorityDigest;
}

/**
 * Test-only compatibility seam for disposable loopback PostgreSQL suites.
 * The caller must already have performed the strict environment/URL checks in
 * `src/test/disposable-database-runtime.ts`; production cannot enable this.
 */
export function installDisposableTestDatabaseRuntime(candidate: DatabaseRuntime): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.VITEST !== 'true' ||
    process.env.HX_ALLOW_CI_DB_RECREATE !== 'true'
  ) {
    throw new Error('DISPOSABLE_TEST_DATABASE_RUNTIME_FORBIDDEN');
  }
  if (installedRuntime) throw new Error('DATABASE_RUNTIME_ALREADY_INSTALLED');
  installedRuntime = candidate;
  installedAuthorityDigest = 'test-only-disposable-runtime';
}

export function databaseRuntimeAuthorityDigest(): string | null {
  return installedAuthorityDigest;
}

/** Current exact pool receipt; an unbound process reports an inert zero shape. */
export function getPoolStats(): RuntimeDatabaseDataPlanePoolStats {
  if (!installedRuntime) {
    return {
      totalConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      maxConnections: 0,
      utilizationPercent: 0,
      replicaConnections: null,
      replicaIdle: null,
      replicaConfigured: false,
    };
  }
  return installedRuntime.stats();
}

// ============================================================================
// HUSTLEXP ERROR CODES
// ============================================================================

/**
 * HustleXP-specific error codes raised by database triggers.
 * These map to invariant violations.
 *
 * @see PRODUCT_SPEC.md §10 (Error Codes)
 * @see backend/database/constitutional-schema.sql (Error code reference)
 */
export const HX_ERROR_CODES = {
  // Terminal state violations
  HX001: 'Task terminal state violation - Cannot modify task in COMPLETED/CANCELLED/EXPIRED state',
  HX002:
    'Escrow terminal state violation - Cannot modify escrow in RELEASED/REFUNDED/REFUND_PARTIAL state',

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

export type { QueryFn, QueryResult } from './database-contracts.js';

/**
 * Database query function signature.
 * Extracted as a named type to break circular reference in the db object
 * and ensure TypeScript properly infers generic type arguments on all callers.
 */
/**
 * Database client interface.
 * Explicit interface prevents TypeScript from losing generic type information
 * when the db object self-references (e.g., healthCheck calling db.query).
 */
export interface Database {
  query: QueryFn;
  /** Execute through the primary-only repeatable-read data-plane path. */
  readQuery: QueryFn;
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
  readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
  serializableTransaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
  healthCheck: () => Promise<{
    connected: boolean;
    schemaVersion: string | null;
    latencyMs: number;
  }>;
  getPoolStats: () => RuntimeDatabaseDataPlanePoolStats;
  close: () => Promise<void>;
}

export const db: Database = {
  query: async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> => {
    const startMs = Date.now();
    const result = await runtime().query<T>(sql, params);
    const durationMs = Date.now() - startMs;
    if (durationMs > 1000) {
      dbLog.warn(
        {
          durationMs,
          query: sql
            .slice(0, 200)
            .replace(/[\w.-]+@[\w.-]+/g, '[EMAIL]')
            .replace(/\+?\d{10,}/g, '[PHONE]'),
        },
        'Slow query detected'
      );
    }
    return result;
  },

  readQuery: async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> => runtime().readQuery<T>(sql, params),

  transaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
    runtime().transaction(fn),

  serializableTransaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
    runtime().serializableTransaction(fn),

  readOnlyAttestationTransaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
    runtime().readOnlyAttestationTransaction(fn),

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
    } catch (_error) {
      return {
        connected: false,
        schemaVersion: null,
        latencyMs: Date.now() - start,
      };
    }
  },

  getPoolStats,

  close: async () => {
    if (!installedRuntime) return;
    await installedRuntime.close();
    dbLog.info('Attested database runtime closed');
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
    dbLog.error({ err: error }, 'Health check failed');
    return {
      database: false,
      schemaVersion: null,
      triggers: 0,
      latencyMs: Date.now() - start,
    };
  }
}

export default db;
