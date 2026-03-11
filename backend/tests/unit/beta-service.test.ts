import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    beta: {
      enabled: true,
      regionName: 'Seattle Metro',
      bounds: { south: 47.4, west: -122.5, north: 47.8, east: -122.2 },
      startDate: '2026-01-01',
      endDate: '2099-12-31',
      maxUsers: 100,
      maxTasks: 200,
      maxGmvCents: 1_000_000,
    },
  },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { BetaService } from '../../src/services/BetaService';
import { db } from '../../src/db';
import { config } from '../../src/config';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// isWithinBetaRegion
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.isWithinBetaRegion', () => {
  it('returns true for lat/lng inside Seattle bounds', () => {
    expect(BetaService.isWithinBetaRegion(47.6, -122.3)).toBe(true);
  });

  it('returns false for lat/lng outside Seattle bounds', () => {
    expect(BetaService.isWithinBetaRegion(40.0, -74.0)).toBe(false);
  });

  it('returns true for any location when beta disabled', () => {
    (config.beta as any).enabled = false;
    expect(BetaService.isWithinBetaRegion(40.0, -74.0)).toBe(true);
    (config.beta as any).enabled = true;
  });

  it('returns true for boundary coordinates (inclusive)', () => {
    expect(BetaService.isWithinBetaRegion(47.4, -122.5)).toBe(true);
    expect(BetaService.isWithinBetaRegion(47.8, -122.2)).toBe(true);
  });

  it('returns false when just outside boundary', () => {
    expect(BetaService.isWithinBetaRegion(47.39, -122.3)).toBe(false);
    expect(BetaService.isWithinBetaRegion(47.81, -122.3)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isWithinDateWindow
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.isWithinDateWindow', () => {
  it('returns true when current date is within window', () => {
    expect(BetaService.isWithinDateWindow()).toBe(true);
  });

  it('returns true when beta disabled', () => {
    (config.beta as any).enabled = false;
    expect(BetaService.isWithinDateWindow()).toBe(true);
    (config.beta as any).enabled = true;
  });

  it('returns false when past end date', () => {
    const orig = config.beta.endDate;
    (config.beta as any).endDate = '2020-01-01';
    expect(BetaService.isWithinDateWindow()).toBe(false);
    (config.beta as any).endDate = orig;
  });

  it('returns false when before start date', () => {
    const orig = config.beta.startDate;
    (config.beta as any).startDate = '2099-01-01';
    expect(BetaService.isWithinDateWindow()).toBe(false);
    (config.beta as any).startDate = orig;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getBetaStatus
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.getBetaStatus', () => {
  it('returns status with counts from database', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '50' }] }) // users
      .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // tasks
      .mockResolvedValueOnce({ rows: [{ gmv: '500000' }] }); // gmv

    const result = await BetaService.getBetaStatus();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.users.current).toBe(50);
      expect(result.data.tasks.current).toBe(100);
      expect(result.data.gmvCents.current).toBe(500000);
      expect(result.data.canCreateUser).toBe(true);
      expect(result.data.canCreateTask).toBe(true);
    }
  });

  it('shows canCreateUser=false when at max', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [{ count: '50' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '0' }] });

    const result = await BetaService.getBetaStatus();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canCreateUser).toBe(false);
    }
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));

    const result = await BetaService.getBetaStatus();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('BETA_STATUS_FAILED');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// enforceTaskCreation
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.enforceTaskCreation', () => {
  it('returns null when beta disabled', async () => {
    (config.beta as any).enabled = false;
    const result = await BetaService.enforceTaskCreation(47.6, -122.3);
    expect(result).toBeNull();
    (config.beta as any).enabled = true;
  });

  it('returns null when all checks pass', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // task count
      .mockResolvedValueOnce({ rows: [{ gmv: '100' }] }); // gmv

    const result = await BetaService.enforceTaskCreation(47.6, -122.3);
    expect(result).toBeNull();
  });

  it('blocks when task cap reached', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '200' }] });

    const result = await BetaService.enforceTaskCreation(47.6, -122.3);
    expect(result).toContain('task cap');
  });

  it('blocks when GMV cap reached', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '1000000' }] });

    const result = await BetaService.enforceTaskCreation(47.6, -122.3);
    expect(result).toContain('GMV cap');
  });

  it('blocks when outside geo-fence', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '100' }] });

    const result = await BetaService.enforceTaskCreation(40.0, -74.0);
    expect(result).toContain('Seattle Metro');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// logBetaStateChange
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.logBetaStateChange', () => {
  it('inserts audit record', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await BetaService.logBetaStateChange('admin-1', 'BETA_ENABLED', { note: 'test' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('admin_actions'),
      expect.arrayContaining(['admin-1', 'BETA_ENABLED']),
    );
  });

  it('does not throw on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    await expect(BetaService.logBetaStateChange('admin-1', 'BETA_DISABLED')).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// logStartupState
// ═══════════════════════════════════════════════════════════════════════════
describe('BetaService.logStartupState', () => {
  it('logs with system user ID', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await BetaService.logStartupState();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('admin_actions'),
      expect.arrayContaining(['00000000-0000-0000-0000-000000000000', 'BETA_STATE_STARTUP']),
    );
  });

  it('does not throw on failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('table missing'));
    await expect(BetaService.logStartupState()).resolves.not.toThrow();
  });
});
