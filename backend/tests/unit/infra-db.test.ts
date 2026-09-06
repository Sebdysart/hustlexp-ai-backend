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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Use vi.hoisted so mock factory closures can reference these variables
// ---------------------------------------------------------------------------

const { mockClientQuery, mockClientRelease, mockPoolConnect, mockPoolEnd, mockPoolOn, mockPoolQuery } = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();
  const mockPoolConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
  const mockPoolOn = vi.fn();
  const mockPoolQuery = vi.fn();
  return { mockClientQuery, mockClientRelease, mockPoolConnect, mockPoolEnd, mockPoolOn, mockPoolQuery };
});

// ---------------------------------------------------------------------------
// Mock pg BEFORE any imports so the module-level Pool constructor is faked.
// ---------------------------------------------------------------------------

vi.mock('pg', () => {
  // Vitest 4 preserves JavaScript constructor semantics for `new Pool()` and
  // correctly rejects an arrow-function mock implementation as non-
  // constructable. Model the pg surface with a real test-only constructor.
  class MockPool {
    connect = mockPoolConnect;
    query = mockPoolQuery;
    end = mockPoolEnd;
    on = mockPoolOn;
    totalCount = 3;
    idleCount = 1;
    waitingCount = 0;
  }

  return { default: { Pool: MockPool } };
});

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

type DatabaseModule = typeof import('../../src/db');
let db: DatabaseModule['db'];
let getPoolStats: DatabaseModule['getPoolStats'];
let checkHealth: DatabaseModule['checkHealth'];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockClientQuery.mockReset();
  mockPoolQuery.mockReset();
  mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  mockClientRelease.mockReturnValue(undefined);
  ({ db, getPoolStats, checkHealth } = await import('../../src/db'));
});

afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

async function installMockDisposableRuntime(): Promise<void> {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VITEST', 'true');
  vi.stubEnv('HX_ALLOW_CI_DB_RECREATE', 'true');
  vi.stubEnv('DATABASE_URL', 'postgresql://hx_ci_runner:synthetic@127.0.0.1:5432/hx_ci_invariant_test');
  vi.stubEnv('DATABASE_REPLICA_URL', '');
  vi.stubEnv('DB_POOL_MAX', '20');
  const { installDisposableVitestDatabaseRuntime } = await import('../../src/test/disposable-database-runtime');
  installDisposableVitestDatabaseRuntime();
}

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
    expect(Object.keys(getPoolStats())).toEqual([
      'totalConnections', 'idleConnections', 'waitingRequests', 'maxConnections',
      'utilizationPercent', 'replicaConnections', 'replicaIdle', 'replicaConfigured',
    ]);
  });

  it('utilizationPercent is a number', () => {
    expect(typeof getPoolStats().utilizationPercent).toBe('number');
  });

  it('reports exact zero capacity before installation regardless of DATABASE_URL presence', () => {
    expect(getPoolStats()).toEqual({
      totalConnections: 0, idleConnections: 0, waitingRequests: 0, maxConnections: 0,
      utilizationPercent: 0, replicaConnections: null, replicaIdle: null, replicaConfigured: false,
    });
    expect(mockPoolConnect).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('reports the explicitly installed runtime capacity', async () => {
    await installMockDisposableRuntime();
    expect(getPoolStats()).toEqual({
      totalConnections: 3, idleConnections: 1, waitingRequests: 0, maxConnections: 20,
      utilizationPercent: 15, replicaConnections: null, replicaIdle: null, replicaConfigured: false,
    });
  });
});

describe('db.query', () => {
  it('refuses SQL before runtime installation even when a URL is configured', async () => {
    await expect(db.query('SELECT 1')).rejects.toThrow('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('passes exact SQL and parameters to the installed runtime', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ val: 1 }], rowCount: 1 });
    await expect(db.query('SELECT $1::int AS val', [1])).resolves.toEqual({ rows: [{ val: 1 }], rowCount: 1 });
    expect(mockPoolQuery).toHaveBeenCalledExactlyOnceWith('SELECT $1::int AS val', [1]);
  });
});

describe('db.readQuery', () => {
  it('refuses SQL before runtime installation', async () => {
    await expect(db.readQuery('SELECT 1')).rejects.toThrow('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns the installed runtime result and preserves parameters', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ val: 2 }], rowCount: 1 });
    await expect(db.readQuery('SELECT $1::int AS val', [2])).resolves.toEqual({ rows: [{ val: 2 }], rowCount: 1 });
    expect(mockPoolQuery).toHaveBeenCalledExactlyOnceWith('SELECT $1::int AS val', [2]);
  });
});

describe.each([
  ['transaction', 'BEGIN'],
  ['serializableTransaction', 'BEGIN ISOLATION LEVEL SERIALIZABLE'],
] as const)('db.%s', (mode, beginStatement) => {
  it('refuses entry before runtime installation without calling the callback', async () => {
    const callback = vi.fn();
    await expect(db[mode](callback)).rejects.toThrow('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED');
    expect(callback).not.toHaveBeenCalled();
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('commits the result on the same bound client', async () => {
    await installMockDisposableRuntime();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ x: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(db[mode](async (query) => (await query('SELECT $1::int AS x', [1])).rows[0]))
      .resolves.toEqual({ x: 1 });
    expect(mockClientQuery.mock.calls.map(([sql]) => sql)).toEqual([beginStatement, 'SELECT $1::int AS x', 'COMMIT']);
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, 'SELECT $1::int AS x', [1]);
    expect(mockClientRelease).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('rolls back and preserves the original error', async () => {
    await installMockDisposableRuntime();
    const failure = new Error(mode + '-error');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(db[mode](async (query) => { await query('BLOW UP'); })).rejects.toBe(failure);
    expect(mockClientQuery.mock.calls.map(([sql]) => sql)).toEqual([beginStatement, 'BLOW UP', 'ROLLBACK']);
    expect(mockClientRelease).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('db raw-pool containment', () => {
  it('does not expose a Pool or physical client', () => {
    expect(db).not.toHaveProperty('getPool');
  });
});

describe('db.healthCheck', () => {
  it('reports disconnected before runtime installation', async () => {
    expect(await db.healthCheck()).toEqual({ connected: false, schemaVersion: null, latencyMs: expect.any(Number) });
  });

  it('returns the installed runtime schema version', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ version: 'v1.0.0' }], rowCount: 1 });
    expect(await db.healthCheck()).toEqual({ connected: true, schemaVersion: 'v1.0.0', latencyMs: expect.any(Number) });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it('reports disconnected on installed runtime query failure', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockRejectedValueOnce(new Error('connection refused'));
    expect(await db.healthCheck()).toEqual({ connected: false, schemaVersion: null, latencyMs: expect.any(Number) });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it('returns a null schema version when the installed runtime returns no rows', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await db.healthCheck()).toEqual({ connected: true, schemaVersion: null, latencyMs: expect.any(Number) });
  });
});

describe('checkHealth', () => {
  it('reports no database before runtime installation', async () => {
    expect(await checkHealth()).toEqual({ database: false, schemaVersion: null, triggers: 0, latencyMs: expect.any(Number) });
  });

  it('reports the installed schema version and trigger count', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ version: 'v1.0.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '12' }], rowCount: 1 });
    expect(await checkHealth()).toEqual({ database: true, schemaVersion: 'v1.0.0', triggers: 12, latencyMs: expect.any(Number) });
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('reports no database on installed runtime failure', async () => {
    await installMockDisposableRuntime();
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await checkHealth()).toEqual({ database: false, schemaVersion: null, triggers: 0, latencyMs: expect.any(Number) });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});

describe('db.close', () => {
  it('is inert before runtime installation', async () => {
    await expect(db.close()).resolves.toBeUndefined();
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });

  it('closes the explicitly installed runtime', async () => {
    await installMockDisposableRuntime();
    await expect(db.close()).resolves.toBeUndefined();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });
});
