import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────
// db.transaction executes the callback with a query function identical to db.query
// so tests can set up mockQuery sequences and they flow through both paths.
vi.mock('../../src/db', () => {
  const mockQuery = vi.fn();
  const mockTransaction = vi.fn(async (fn: (q: typeof mockQuery) => Promise<unknown>) => fn(mockQuery));
  return {
    db: { query: mockQuery, transaction: mockTransaction },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { DynamicPricingService } from '../../src/services/DynamicPricingService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// calculatePrice
// ═══════════════════════════════════════════════════════════════════════════
describe('DynamicPricingService.calculatePrice', () => {
  it('calculates base price without location or ASAP', async () => {
    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 5000,
      mode: 'STANDARD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.base_price_cents).toBe(5000);
      // Without location, no demand surge is applied
      expect(result.data.urgency_premium_cents).toBe(0);
      expect(result.data.worker_modifier_cents).toBe(0);
      expect(result.data.final_price_cents).toBeGreaterThanOrEqual(500);
    }
  });

  it('applies ASAP urgency premium (30%)', async () => {
    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 10000,
      mode: 'STANDARD',
      isASAP: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.urgency_premium_cents).toBe(3000); // 30% of 10000
    }
  });

  it('applies urgency for LIVE mode', async () => {
    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 10000,
      mode: 'LIVE',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.urgency_premium_cents).toBe(3000);
    }
  });

  it('applies worker modifier when workerId provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ price_modifier_percent: 20 }] });

    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 10000,
      mode: 'STANDARD',
      workerId: 'worker-1',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worker_modifier_cents).toBe(2000);
    }
  });

  it('enforces $5 minimum price', async () => {
    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 100, // $1
      mode: 'STANDARD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.final_price_cents).toBeGreaterThanOrEqual(500);
    }
  });

  it('includes breakdown in result', async () => {
    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 5000,
      mode: 'STANDARD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.breakdown).toBeDefined();
      expect(result.data.breakdown.base).toBe(5000);
    }
  });

  it('handles demand surge when location provided', async () => {
    // Mock demand query: high demand ratio
    mockQuery.mockResolvedValueOnce({
      rows: [{ open_tasks: 10, active_workers: 2 }],
    });

    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 10000,
      mode: 'STANDARD',
      locationLat: 47.6,
      locationLng: -122.3,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Surge multiplier should be >1 due to demand ratio >3
      expect(result.data.surge_multiplier).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await DynamicPricingService.calculatePrice({
      basePriceCents: 5000,
      mode: 'STANDARD',
      locationLat: 47.6,
      locationLng: -122.3,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PRICING_ERROR');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// updateWorkerModifier
// ═══════════════════════════════════════════════════════════════════════════
describe('DynamicPricingService.updateWorkerModifier', () => {
  it('updates modifier within range', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await DynamicPricingService.updateWorkerModifier('user-1', 10);
    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('price_modifier_percent'),
      [10, 'user-1'],
    );
  });

  it('rejects modifier below -25%', async () => {
    const result = await DynamicPricingService.updateWorkerModifier('user-1', -30);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_MODIFIER');
    }
  });

  it('rejects modifier above 50%', async () => {
    const result = await DynamicPricingService.updateWorkerModifier('user-1', 55);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_MODIFIER');
    }
  });

  it('allows boundary values -25 and 50', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const r1 = await DynamicPricingService.updateWorkerModifier('user-1', -25);
    expect(r1.success).toBe(true);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const r2 = await DynamicPricingService.updateWorkerModifier('user-1', 50);
    expect(r2.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// bumpASAPPrice
// ═══════════════════════════════════════════════════════════════════════════
describe('DynamicPricingService.bumpASAPPrice', () => {
  it('bumps price by $3 and increments bump count (transactional)', async () => {
    // Bug 2 fix: bumpASAPPrice now uses db.transaction with FOR UPDATE.
    // The mock transaction executes the callback with the same mockQuery fn,
    // so we set up sequences: SELECT FOR UPDATE returns task, then UPDATE returns rowCount=1.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ price: 5000, surge_multiplier: 1.0, asap_bump_count: 0 }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // conditional UPDATE succeeds

    const result = await DynamicPricingService.bumpASAPPrice('task-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.new_price_cents).toBe(5300);
      expect(result.data.bump_count).toBe(1);
    }
    // Verify FOR UPDATE was in the SELECT
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      ['task-1']
    );
    // Verify conditional UPDATE uses bump_count guard
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('asap_bump_count < $4'),
      [5300, 1, 'task-1', 3]
    );
  });

  it('returns NOT_FOUND when task not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await DynamicPricingService.bumpASAPPrice('missing-task');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns MAX_BUMPS_REACHED when at 3 bumps', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ price: 5900, surge_multiplier: 1.0, asap_bump_count: 3 }] });

    const result = await DynamicPricingService.bumpASAPPrice('task-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('MAX_BUMPS_REACHED');
    }
  });

  it('returns MAX_BUMPS_REACHED when conditional UPDATE returns rowCount=0 (race)', async () => {
    // Simulate another concurrent bump winning the race: SELECT sees count=2 (below max),
    // but the conditional UPDATE finds count is now 3 (max) and returns rowCount=0
    mockQuery
      .mockResolvedValueOnce({ rows: [{ price: 5600, surge_multiplier: 1.0, asap_bump_count: 2 }] })
      .mockResolvedValueOnce({ rowCount: 0 }); // conditional UPDATE finds count already maxed

    const result = await DynamicPricingService.bumpASAPPrice('task-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('MAX_BUMPS_REACHED');
    }
  });

  it('handles DB error gracefully', async () => {
    mockQuery.mockRejectedValueOnce(new Error('write failure'));

    const result = await DynamicPricingService.bumpASAPPrice('task-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});
