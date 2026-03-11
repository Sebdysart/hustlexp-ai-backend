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

vi.mock('../../src/services/CapabilityRecomputeService', () => ({
  recomputeCapabilityProfile: vi.fn(),
}));

vi.mock('../../src/cache/redis', () => ({
  redis: { del: vi.fn(), get: vi.fn(), set: vi.fn() },
  CACHE_KEYS: { taskFeed: (uid: string) => `feed:${uid}` },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import {
  getCapabilityProfile,
  getCapabilitySummary,
  hasCapability,
  getUserCapabilities,
  recompute,
  initializeProfile,
  getProfilesBatch,
  findUsersWithCapability,
  invalidateProfileFeedCache,
} from '../../src/services/CapabilityProfileService';
import { db } from '../../src/db';
import { redis } from '../../src/cache/redis';

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const mockRedisDel = redis.del as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const profileRow = {
  user_id: 'user-1',
  trust_tier: 'B',
  risk_clearance: ['low', 'medium', 'high'],
  location_state: 'WA',
  location_city: 'Seattle',
  insurance_valid: true,
  insurance_expires_at: '2027-01-01',
  background_check_valid: true,
  background_check_expires_at: '2027-06-01',
  updated_at: '2026-03-01',
};

const tradeRows = [
  { trade: 'plumbing', state: 'WA', expires_at: '2027-01-01', license_verification_id: 'lv-1' },
];

// ═══════════════════════════════════════════════════════════════════════════
// getCapabilityProfile
// ═══════════════════════════════════════════════════════════════════════════
describe('getCapabilityProfile', () => {
  it('returns profile with verified trades', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [profileRow] }) // profile query
      .mockResolvedValueOnce({ rows: tradeRows }); // trades query

    const profile = await getCapabilityProfile('user-1');
    expect(profile.userId).toBe('user-1');
    expect(profile.trustTier).toBe('B');
    expect(profile.verifiedTrades).toHaveLength(1);
    expect(profile.insuranceValid).toBe(true);
  });

  it('throws TRPCError when profile not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(getCapabilityProfile('missing')).rejects.toThrow('not found');
  });

  it('defaults riskClearance to [low] when null', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...profileRow, risk_clearance: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const profile = await getCapabilityProfile('user-1');
    expect(profile.riskClearance).toEqual(['low']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getCapabilitySummary
// ═══════════════════════════════════════════════════════════════════════════
describe('getCapabilitySummary', () => {
  it('returns canWork=true when profile is healthy', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [profileRow] })
      .mockResolvedValueOnce({ rows: tradeRows });

    const summary = await getCapabilitySummary('user-1');
    expect(summary.canWork).toBe(true);
    expect(summary.blockingReasons).toHaveLength(0);
  });

  it('returns canWork=false with blocking reasons when no trades', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...profileRow, insurance_valid: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const summary = await getCapabilitySummary('user-1');
    expect(summary.canWork).toBe(false);
    expect(summary.blockingReasons).toContain('No verified trades');
    expect(summary.blockingReasons).toContain('Insurance not verified');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hasCapability
// ═══════════════════════════════════════════════════════════════════════════
describe('hasCapability', () => {
  it('returns true when user has matching trade and risk clearance', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [profileRow] })
      .mockResolvedValueOnce({ rows: tradeRows });

    const result = await hasCapability('user-1', 'plumbing', 'WA', 'medium');
    expect(result).toBe(true);
  });

  it('returns false when risk level exceeds clearance', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...profileRow, risk_clearance: ['low'] }] })
      .mockResolvedValueOnce({ rows: tradeRows });

    const result = await hasCapability('user-1', 'plumbing', 'WA', 'high');
    expect(result).toBe(false);
  });

  it('returns false when trade not found', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [profileRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await hasCapability('user-1', 'electrical', 'WA', 'low');
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getUserCapabilities
// ═══════════════════════════════════════════════════════════════════════════
describe('getUserCapabilities', () => {
  it('returns deduplicated trades and states', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [profileRow] })
      .mockResolvedValueOnce({ rows: tradeRows });

    const caps = await getUserCapabilities('user-1');
    expect(caps.trades).toEqual(['plumbing']);
    expect(caps.states).toEqual(['WA']);
    expect(caps.insuranceValid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// recompute
// ═══════════════════════════════════════════════════════════════════════════
describe('recompute', () => {
  it('triggers recompute and invalidates feed cache', async () => {
    mockRedisDel.mockResolvedValueOnce(1);

    await recompute('user-1', 'test');
    expect(mockRedisDel).toHaveBeenCalledWith('feed:user-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// initializeProfile
// ═══════════════════════════════════════════════════════════════════════════
describe('initializeProfile', () => {
  it('inserts default profile and recomputes', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockRedisDel.mockResolvedValueOnce(1);

    await initializeProfile('user-1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('capability_profiles'),
      expect.arrayContaining(['user-1']),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// findUsersWithCapability
// ═══════════════════════════════════════════════════════════════════════════
describe('findUsersWithCapability', () => {
  it('returns user IDs with matching capability', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }, { user_id: 'user-2' }] });

    const ids = await findUsersWithCapability('plumbing', 'WA');
    expect(ids).toEqual(['user-1', 'user-2']);
  });

  it('returns empty array when no matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const ids = await findUsersWithCapability('unknown', 'XX');
    expect(ids).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// invalidateProfileFeedCache
// ═══════════════════════════════════════════════════════════════════════════
describe('invalidateProfileFeedCache', () => {
  it('deletes the feed cache key', async () => {
    mockRedisDel.mockResolvedValueOnce(1);

    await invalidateProfileFeedCache('user-1');
    expect(mockRedisDel).toHaveBeenCalledWith('feed:user-1');
  });
});
