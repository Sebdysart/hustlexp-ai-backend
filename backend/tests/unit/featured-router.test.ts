/**
 * Featured Router Unit Tests
 *
 * Tests all protected procedures:
 * - promoteTask (mutation)
 * - confirmPromotion (mutation)
 * - getFeaturedTasks (query)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
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
    stripe: { secretKey: '' }, // Empty = no Stripe in tests
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    logEvent: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { featuredRouter } from '../../src/routers/featured';
import { RevenueService } from '../../src/services/RevenueService';

const mockDb = vi.mocked(db);
const mockRevenue = vi.mocked(RevenueService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeCaller() {
  return featuredRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('featured router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // promoteTask
  // =========================================================================
  describe('promoteTask', () => {
    it('creates promotion listing on success (no Stripe key)', async () => {
      // Task ownership check
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID1 }],
        rowCount: 1,
      } as any);
      // Existing promotion check
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Insert listing
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'listing-1' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      const result = await caller.promoteTask({
        taskId: UUID2,
        featureType: 'promoted',
      });

      expect(result.success).toBe(true);
      expect(result.listingId).toBe('listing-1');
      expect(result.clientSecret).toBeNull();
      expect(result.feeCents).toBe(299);
    });

    it('throws NOT_FOUND when task not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.promoteTask({
        taskId: UUID2,
        featureType: 'promoted',
      })).rejects.toThrow('Task not found');
    });

    it('throws NOT_FOUND when task not owned by user', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID2 }], // Different user
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      await expect(caller.promoteTask({
        taskId: UUID2,
        featureType: 'promoted',
      })).rejects.toThrow('Task not found or not owned by user');
    });

    it('throws CONFLICT when task already has active promotion', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID1 }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-listing' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      await expect(caller.promoteTask({
        taskId: UUID2,
        featureType: 'highlighted',
      })).rejects.toThrow('already has an active promotion');
    });

    it('uses correct pricing for highlighted', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1 }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'listing-2' }], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.promoteTask({
        taskId: UUID2,
        featureType: 'highlighted',
      });

      expect(result.feeCents).toBe(499);
    });

    it('uses correct pricing for urgent_boost', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1 }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'listing-3' }], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.promoteTask({
        taskId: UUID2,
        featureType: 'urgent_boost',
      });

      expect(result.feeCents).toBe(799);
    });
  });

  // =========================================================================
  // confirmPromotion
  // =========================================================================
  describe('confirmPromotion', () => {
    const LISTING_UUID = '00000000-0000-0000-0000-000000000099';

    it('activates listing when payment confirmed (no Stripe key)', async () => {
      // Update listing
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: LISTING_UUID, fee_cents: 299, task_id: UUID2, feature_type: 'promoted' }],
        rowCount: 1,
      } as any);
      // Revenue logging
      mockRevenue.logEvent.mockResolvedValue(undefined as any);

      const caller = makeCaller();
      const result = await caller.confirmPromotion({
        listingId: LISTING_UUID,
        stripePaymentIntentId: 'pi_test_123',
      });

      expect(result.success).toBe(true);
      expect(result.active).toBe(true);
      expect(mockRevenue.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'featured_listing',
          amountCents: 299,
        }),
      );
    });

    it('throws NOT_FOUND when listing not found or already activated', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.confirmPromotion({
        listingId: UUID2,
        stripePaymentIntentId: 'pi_test_123',
      })).rejects.toThrow('Featured listing not found');
    });
  });

  // =========================================================================
  // getFeaturedTasks
  // =========================================================================
  describe('getFeaturedTasks', () => {
    it('returns active featured tasks', async () => {
      const rows = [
        { id: 'listing-1', task_id: UUID2, title: 'Test Task', feature_type: 'promoted' },
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.getFeaturedTasks();

      expect(result).toEqual(rows);
      const sql = (mockDb.query as any).mock.calls[0][0];
      expect(sql).toContain('active = TRUE');
      expect(sql).toContain('expires_at > NOW()');
    });

    it('returns empty array when no featured tasks', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      const result = await caller.getFeaturedTasks();

      expect(result).toEqual([]);
    });
  });
});
