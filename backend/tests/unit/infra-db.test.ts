/**
 * infra-db.test.ts
 *
 * Unit tests for backend/src/db.ts
 *
 * Covers:
 *  - hasDb export
 *  - getPoolStats()
 *  - HX_ERROR_CODES constant
 *  - isInvariantViolation()
 *  - getHXErrorCode()
 *  - isInv1Violation(), isInv2Violation(), isInv3Violation(), isInv4Violation()
 *  - isTaskTerminalViolation(), isEscrowTerminalViolation()
 *  - isLiveModeViolation()
 *  - isUniqueViolation()
 *  - getErrorMessage()
 *  - db.healthCheck() — success and error paths
 *  - checkHealth() — success and error paths
 *  - db.close() — no-op when pool is null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Use vi.hoisted so mock factory closures can reference these variables
// ---------------------------------------------------------------------------

const { mockClientQuery, mockClientRelease, mockPoolConnect, mockPoolEnd, mockPoolOn } = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();
  const mockPoolConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
  const mockPoolOn = vi.fn();
  return { mockClientQuery, mockClientRelease, mockPoolConnect, mockPoolEnd, mockPoolOn };
});

// ---------------------------------------------------------------------------
// Mock pg BEFORE any imports so the module-level Pool constructor is faked.
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({
      connect: mockPoolConnect,
      end: mockPoolEnd,
      on: mockPoolOn,
      totalCount: 3,
      idleCount: 1,
      waitingCount: 0,
    })),
  },
}));

// Mock logger so we don't get pino initialisation side-effects
vi.mock('../../src/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import {
  hasDb,
  getPoolStats,
  HX_ERROR_CODES,
  isInvariantViolation,
  getHXErrorCode,
  isInv1Violation,
  isInv2Violation,
  isInv3Violation,
  isInv4Violation,
  isTaskTerminalViolation,
  isEscrowTerminalViolation,
  isLiveModeViolation,
  isUniqueViolation,
  getErrorMessage,
  checkHealth,
  db,
} from '../../src/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an Error with an attached `code` field (like node-postgres does). */
function makeDbError(code: string, message = 'DB Error'): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  mockClientRelease.mockReturnValue(undefined);
});

// ===========================================================================
// hasDb
// ===========================================================================

describe('hasDb', () => {
  it('is a boolean', () => {
    expect(typeof hasDb).toBe('boolean');
  });
});

// ===========================================================================
// HX_ERROR_CODES
// ===========================================================================

describe('HX_ERROR_CODES', () => {
  it('exports a non-empty object', () => {
    expect(Object.keys(HX_ERROR_CODES).length).toBeGreaterThan(0);
  });

  it('contains key HX001', () => {
    expect(HX_ERROR_CODES.HX001).toBeDefined();
  });

  it('contains key HX101 (INV-1)', () => {
    expect(HX_ERROR_CODES.HX101).toContain('INV-1');
  });

  it('contains key HX201 (INV-2)', () => {
    expect(HX_ERROR_CODES.HX201).toContain('INV-2');
  });

  it('contains key HX301 (INV-3)', () => {
    expect(HX_ERROR_CODES.HX301).toContain('INV-3');
  });

  it('contains all live-mode codes HX901-HX905', () => {
    (['HX901', 'HX902', 'HX903', 'HX904', 'HX905'] as Array<keyof typeof HX_ERROR_CODES>).forEach((code) => {
      expect(HX_ERROR_CODES[code]).toBeDefined();
    });
  });
});

// ===========================================================================
// isInvariantViolation
// ===========================================================================

describe('isInvariantViolation', () => {
  it('returns false for non-Error values', () => {
    expect(isInvariantViolation(null)).toBe(false);
    expect(isInvariantViolation('string')).toBe(false);
    expect(isInvariantViolation(42)).toBe(false);
    expect(isInvariantViolation({})).toBe(false);
  });

  it('returns false for Error without code', () => {
    expect(isInvariantViolation(new Error('no code'))).toBe(false);
  });

  it('returns false for Error with non-HX code', () => {
    expect(isInvariantViolation(makeDbError('23505'))).toBe(false);
    expect(isInvariantViolation(makeDbError('P2002'))).toBe(false);
  });

  it('returns false for HX code not in HX_ERROR_CODES (e.g. HX999)', () => {
    expect(isInvariantViolation(makeDbError('HX999'))).toBe(false);
  });

  it('returns true for a known HX code (HX001)', () => {
    expect(isInvariantViolation(makeDbError('HX001'))).toBe(true);
  });

  it('returns true for HX101 (INV-1)', () => {
    expect(isInvariantViolation(makeDbError('HX101'))).toBe(true);
  });

  it('returns true for all known HX codes', () => {
    for (const code of Object.keys(HX_ERROR_CODES)) {
      expect(isInvariantViolation(makeDbError(code))).toBe(true);
    }
  });
});

// ===========================================================================
// getHXErrorCode
// ===========================================================================

describe('getHXErrorCode', () => {
  it('returns null for non-invariant errors', () => {
    expect(getHXErrorCode(new Error('generic'))).toBeNull();
    expect(getHXErrorCode(null)).toBeNull();
  });

  it('returns the code for a known HX error', () => {
    expect(getHXErrorCode(makeDbError('HX001'))).toBe('HX001');
    expect(getHXErrorCode(makeDbError('HX201'))).toBe('HX201');
    expect(getHXErrorCode(makeDbError('HX901'))).toBe('HX901');
  });
});

// ===========================================================================
// Violation helpers
// ===========================================================================

describe('isInv1Violation', () => {
  it('returns true for HX101', () => {
    expect(isInv1Violation(makeDbError('HX101'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isInv1Violation(makeDbError('HX201'))).toBe(false);
    expect(isInv1Violation(new Error('plain'))).toBe(false);
  });
});

describe('isInv2Violation', () => {
  it('returns true for HX201', () => {
    expect(isInv2Violation(makeDbError('HX201'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isInv2Violation(makeDbError('HX101'))).toBe(false);
  });
});

describe('isInv3Violation', () => {
  it('returns true for HX301', () => {
    expect(isInv3Violation(makeDbError('HX301'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isInv3Violation(makeDbError('HX201'))).toBe(false);
  });
});

describe('isInv4Violation', () => {
  it('returns true for HX004', () => {
    expect(isInv4Violation(makeDbError('HX004'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isInv4Violation(makeDbError('HX001'))).toBe(false);
  });
});

describe('isTaskTerminalViolation', () => {
  it('returns true for HX001', () => {
    expect(isTaskTerminalViolation(makeDbError('HX001'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isTaskTerminalViolation(makeDbError('HX002'))).toBe(false);
  });
});

describe('isEscrowTerminalViolation', () => {
  it('returns true for HX002', () => {
    expect(isEscrowTerminalViolation(makeDbError('HX002'))).toBe(true);
  });
  it('returns false for other codes', () => {
    expect(isEscrowTerminalViolation(makeDbError('HX001'))).toBe(false);
  });
});

// ===========================================================================
// isLiveModeViolation
// ===========================================================================

describe('isLiveModeViolation', () => {
  it('returns true for HX901-HX905', () => {
    ['HX901', 'HX902', 'HX903', 'HX904', 'HX905'].forEach((code) => {
      expect(isLiveModeViolation(makeDbError(code))).toBe(true);
    });
  });

  it('returns false for non-live-mode HX codes', () => {
    expect(isLiveModeViolation(makeDbError('HX001'))).toBe(false);
    expect(isLiveModeViolation(makeDbError('HX101'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isLiveModeViolation(null)).toBe(false);
  });
});

// ===========================================================================
// isUniqueViolation
// ===========================================================================

describe('isUniqueViolation', () => {
  it('returns true for PostgreSQL unique-constraint code 23505', () => {
    expect(isUniqueViolation(makeDbError('23505'))).toBe(true);
  });

  it('returns false for other pg error codes', () => {
    expect(isUniqueViolation(makeDbError('23503'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

// ===========================================================================
// getErrorMessage
// ===========================================================================

describe('getErrorMessage', () => {
  it('returns the human-readable message for a known HX code', () => {
    const msg = getErrorMessage('HX001');
    expect(msg).toContain('terminal');
  });

  it('returns a fallback string for an unknown code', () => {
    const msg = getErrorMessage('HX999');
    expect(msg).toContain('HX999');
  });

  it('covers all known HX codes', () => {
    for (const code of Object.keys(HX_ERROR_CODES)) {
      const msg = getErrorMessage(code);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// getPoolStats
// ===========================================================================

describe('getPoolStats', () => {
  it('returns an object with the expected shape', () => {
    const stats = getPoolStats();
    expect(stats).toHaveProperty('totalConnections');
    expect(stats).toHaveProperty('idleConnections');
    expect(stats).toHaveProperty('waitingRequests');
    expect(stats).toHaveProperty('maxConnections');
    expect(stats).toHaveProperty('utilizationPercent');
    expect(stats).toHaveProperty('replicaConnections');
    expect(stats).toHaveProperty('replicaIdle');
    expect(stats).toHaveProperty('replicaConfigured');
  });

  it('utilizationPercent is a number', () => {
    const stats = getPoolStats();
    expect(typeof stats.utilizationPercent).toBe('number');
  });

  it('maxConnections is a positive number', () => {
    const stats = getPoolStats();
    expect(stats.maxConnections).toBeGreaterThan(0);
  });
});

// ===========================================================================
// db.query — depends on whether pool is available
// ===========================================================================

describe('db.query', () => {
  it('throws when pool is null (no DATABASE_URL)', async () => {
    if (!hasDb) {
      await expect(db.query('SELECT 1')).rejects.toThrow('DATABASE_URL');
    } else {
      // Pool exists — mock queries
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL
        .mockResolvedValueOnce({ rows: [{ val: 1 }], rowCount: 1 });
      const result = await db.query('SELECT 1');
      expect(result).toHaveProperty('rows');
    }
  });
});

// ===========================================================================
// db.readQuery — depends on pool availability
// ===========================================================================

describe('db.readQuery', () => {
  it('throws when pool is null (no DATABASE_URL)', async () => {
    if (!hasDb) {
      await expect(db.readQuery('SELECT 1')).rejects.toThrow('DATABASE_URL');
    } else {
      mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await db.readQuery('SELECT 1');
      expect(result).toHaveProperty('rows');
    }
  });
});

// ===========================================================================
// db.transaction — depends on pool availability
// ===========================================================================

describe('db.transaction', () => {
  it('throws when pool is null (no DATABASE_URL)', async () => {
    if (!hasDb) {
      await expect(db.transaction(async () => 'result')).rejects.toThrow('DATABASE_URL');
    } else {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ x: 1 }], rowCount: 1 }) // user query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      const result = await db.transaction(async (q) => {
        const r = await q('SELECT 1');
        return r.rows[0];
      });
      expect(result).toEqual({ x: 1 });
    }
  });

  it('rolls back and rethrows on error (when pool exists)', async () => {
    if (!hasDb) return;

    const boom = new Error('tx-error');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(boom) // user fn throws
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(
      db.transaction(async (q) => {
        await q('BLOW UP');
      }),
    ).rejects.toThrow('tx-error');
  });
});

// ===========================================================================
// db.serializableTransaction — depends on pool availability
// ===========================================================================

describe('db.serializableTransaction', () => {
  it('throws when pool is null (no DATABASE_URL)', async () => {
    if (!hasDb) {
      await expect(db.serializableTransaction(async () => 'r')).rejects.toThrow('DATABASE_URL');
    } else {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN ISOLATION LEVEL SERIALIZABLE
        .mockResolvedValueOnce({ rows: [{ v: 42 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      const result = await db.serializableTransaction(async (q) => {
        const r = await q('SELECT 42');
        return r.rows[0];
      });
      expect(result).toEqual({ v: 42 });
    }
  });

  it('rolls back and rethrows on serializable tx error (when pool exists)', async () => {
    if (!hasDb) return;

    const boom = new Error('serializable-tx-error');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN ISOLATION...
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(
      db.serializableTransaction(async (q) => {
        await q('BLOW UP');
      }),
    ).rejects.toThrow('serializable-tx-error');
  });
});

// ===========================================================================
// db.getPool
// ===========================================================================

describe('db.getPool', () => {
  it('throws when pool is null (no DATABASE_URL)', () => {
    if (!hasDb) {
      expect(() => db.getPool()).toThrow('DATABASE_URL');
    } else {
      expect(db.getPool()).toBeDefined();
    }
  });
});

// ===========================================================================
// db.healthCheck — uses db.query internally
// ===========================================================================

describe('db.healthCheck', () => {
  it('returns connected:false when no pool (no DATABASE_URL)', async () => {
    if (!hasDb) {
      const result = await db.healthCheck();
      expect(result.connected).toBe(false);
      expect(result.schemaVersion).toBeNull();
      expect(typeof result.latencyMs).toBe('number');
    }
  });

  it('returns connected:true with schema version on success (when pool exists)', async () => {
    if (!hasDb) return;

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL
      .mockResolvedValueOnce({ rows: [{ version: 'v1.0.0' }], rowCount: 1 });

    const result = await db.healthCheck();
    expect(result.connected).toBe(true);
    expect(result.schemaVersion).toBe('v1.0.0');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns connected:false on query error (when pool exists)', async () => {
    if (!hasDb) return;

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL
      .mockRejectedValueOnce(new Error('connection refused'));

    const result = await db.healthCheck();
    expect(result.connected).toBe(false);
    expect(result.schemaVersion).toBeNull();
  });

  it('returns null schemaVersion when no rows returned (when pool exists)', async () => {
    if (!hasDb) return;

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no schema version rows

    const result = await db.healthCheck();
    expect(result.connected).toBe(true);
    expect(result.schemaVersion).toBeNull();
  });
});

// ===========================================================================
// checkHealth (extended health check)
// ===========================================================================

describe('checkHealth', () => {
  it('returns database:false when no pool', async () => {
    if (!hasDb) {
      const result = await checkHealth();
      expect(result.database).toBe(false);
      expect(result.schemaVersion).toBeNull();
      expect(result.triggers).toBe(0);
    }
  });

  it('returns database:true with trigger count on success (when pool exists)', async () => {
    if (!hasDb) return;

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL (version query)
      .mockResolvedValueOnce({ rows: [{ version: 'v1.0.0' }], rowCount: 1 }) // version query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL (trigger query)
      .mockResolvedValueOnce({ rows: [{ count: '12' }], rowCount: 1 }); // trigger count

    const result = await checkHealth();
    expect(result.database).toBe(true);
    expect(result.schemaVersion).toBe('v1.0.0');
    expect(result.triggers).toBe(12);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns database:false on error (when pool exists)', async () => {
    if (!hasDb) return;

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DEALLOCATE ALL
      .mockRejectedValueOnce(new Error('db down'));

    const result = await checkHealth();
    expect(result.database).toBe(false);
    expect(result.schemaVersion).toBeNull();
    expect(result.triggers).toBe(0);
  });
});

// ===========================================================================
// db.close
// ===========================================================================

describe('db.close', () => {
  it('resolves without throwing (regardless of pool state)', async () => {
    await expect(db.close()).resolves.not.toThrow();
  });
});
