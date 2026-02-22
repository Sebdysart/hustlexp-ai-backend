/**
 * DATABASE HEALTH SERVICE
 *
 * Periodic health monitoring for primary and replica database connections.
 * Tracks latency, detects outages, and exposes a health status object
 * consumable by the /health/detailed endpoint.
 *
 * - Primary down  -> CRITICAL log alert
 * - Replica down  -> WARNING log, continue on primary only
 * - Both healthy  -> activeConnections = 'both'
 *
 * Usage:
 *   DatabaseHealthService.start();          // begin 30s polling
 *   DatabaseHealthService.getHealth();      // read current snapshot
 *   DatabaseHealthService.stop();           // teardown on shutdown
 */

import { neon } from '@neondatabase/serverless';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DatabaseHealthService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionHealth {
  healthy: boolean;
  latencyMs: number;
  lastChecked: Date;
  error?: string;
  consecutiveFailures: number;
}

export interface DatabaseHealth {
  primary: ConnectionHealth;
  replica: ConnectionHealth | null;
  activeConnections: 'primary' | 'replica' | 'both';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const QUERY_TIMEOUT_MS = 5_000;   // 5 second query timeout

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let primaryHealth: ConnectionHealth = {
  healthy: false,
  latencyMs: 0,
  lastChecked: new Date(0),
  consecutiveFailures: 0,
};

let replicaHealth: ConnectionHealth | null = null;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Build SQL query functions from env vars (lazily, so env is loaded first)
let primarySql: ReturnType<typeof neon> | null = null;
let replicaSql: ReturnType<typeof neon> | null = null;

function ensureConnections(): void {
  if (!primarySql) {
    const url = process.env.DATABASE_URL;
    if (url) {
      primarySql = neon(url);
    }
  }

  if (!replicaSql) {
    const replicaUrl = process.env.DATABASE_REPLICA_URL;
    if (replicaUrl) {
      replicaSql = neon(replicaUrl);
    }
  }
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

async function probe(
  sqlFn: ReturnType<typeof neon>,
  label: string,
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();

  try {
    // Race the SELECT 1 against a timeout so a hung connection doesn't block
    // the entire check loop.
    const result = await Promise.race([
      sqlFn`SELECT 1 AS ok`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Health check query timed out')), QUERY_TIMEOUT_MS),
      ),
    ]);

    const latencyMs = Date.now() - start;

    if (!result || (result as any[]).length === 0) {
      return { healthy: false, latencyMs, error: `${label}: empty result` };
    }

    return { healthy: true, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return { healthy: false, latencyMs, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// Core check loop
// ---------------------------------------------------------------------------

async function runChecks(): Promise<void> {
  ensureConnections();

  // --- Primary ---
  if (primarySql) {
    const result = await probe(primarySql, 'primary');
    const wasHealthy = primaryHealth.healthy;

    primaryHealth = {
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      lastChecked: new Date(),
      error: result.error,
      consecutiveFailures: result.healthy ? 0 : primaryHealth.consecutiveFailures + 1,
    };

    if (!result.healthy) {
      logger.fatal(
        {
          latencyMs: result.latencyMs,
          error: result.error,
          consecutiveFailures: primaryHealth.consecutiveFailures,
        },
        'CRITICAL: Primary database is unreachable',
      );
    } else if (!wasHealthy && result.healthy) {
      logger.info(
        { latencyMs: result.latencyMs },
        'Primary database recovered',
      );
    }
  } else {
    primaryHealth = {
      healthy: false,
      latencyMs: 0,
      lastChecked: new Date(),
      error: 'DATABASE_URL not configured',
      consecutiveFailures: primaryHealth.consecutiveFailures + 1,
    };
    logger.fatal('CRITICAL: DATABASE_URL is not set — primary database unavailable');
  }

  // --- Replica ---
  if (replicaSql) {
    const result = await probe(replicaSql, 'replica');
    const prev = replicaHealth;
    const wasHealthy = prev?.healthy ?? false;

    replicaHealth = {
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      lastChecked: new Date(),
      error: result.error,
      consecutiveFailures: result.healthy
        ? 0
        : (prev?.consecutiveFailures ?? 0) + 1,
    };

    if (!result.healthy) {
      logger.warn(
        {
          latencyMs: result.latencyMs,
          error: result.error,
          consecutiveFailures: replicaHealth.consecutiveFailures,
        },
        'WARNING: Replica database is unreachable — using primary only',
      );
    } else if (!wasHealthy && result.healthy) {
      logger.info(
        { latencyMs: result.latencyMs },
        'Replica database recovered',
      );
    }
  } else {
    // No replica configured — that's fine, just null it out
    replicaHealth = null;
  }
}

// ---------------------------------------------------------------------------
// Compute active-connections descriptor
// ---------------------------------------------------------------------------

function computeActiveConnections(): 'primary' | 'replica' | 'both' {
  const pOk = primaryHealth.healthy;
  const rOk = replicaHealth?.healthy ?? false;

  if (pOk && rOk) return 'both';
  if (pOk) return 'primary';
  if (rOk) return 'replica';

  // Both down — report primary as the "active" target so callers know
  // which connection the system will attempt to use.
  return 'primary';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DatabaseHealthService {
  /**
   * Start the periodic health-check loop.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  static start(): void {
    if (intervalHandle) return;

    logger.info(
      { intervalMs: CHECK_INTERVAL_MS },
      'Starting database health checks',
    );

    // Run an initial check immediately (fire-and-forget)
    runChecks().catch((err) =>
      logger.error({ err }, 'Initial database health check failed'),
    );

    intervalHandle = setInterval(() => {
      runChecks().catch((err) =>
        logger.error({ err }, 'Database health check iteration failed'),
      );
    }, CHECK_INTERVAL_MS);

    // Allow the process to exit even if the interval is still active
    if (intervalHandle && typeof intervalHandle === 'object' && 'unref' in intervalHandle) {
      intervalHandle.unref();
    }
  }

  /**
   * Stop the periodic health-check loop.
   */
  static stop(): void {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      logger.info('Stopped database health checks');
    }
  }

  /**
   * Return a snapshot of the current database health state.
   */
  static getHealth(): DatabaseHealth {
    return {
      primary: { ...primaryHealth },
      replica: replicaHealth ? { ...replicaHealth } : null,
      activeConnections: computeActiveConnections(),
    };
  }

  /**
   * Convenience: is the primary database healthy right now?
   */
  static isPrimaryHealthy(): boolean {
    return primaryHealth.healthy;
  }

  /**
   * Convenience: is the replica database healthy right now?
   * Returns false when no replica is configured.
   */
  static isReplicaHealthy(): boolean {
    return replicaHealth?.healthy ?? false;
  }

  /**
   * Force an immediate check cycle (useful in tests or on-demand probes).
   */
  static async checkNow(): Promise<DatabaseHealth> {
    await runChecks();
    return DatabaseHealthService.getHealth();
  }
}
