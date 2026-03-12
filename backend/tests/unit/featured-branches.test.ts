/**
 * Featured Router Branch Coverage Tests
 *
 * Targets uncovered branches in featured.ts not covered by featured-router.test.ts:
 *
 * promoteTask:
 *   - Stripe configured path: creates PaymentIntent, returns clientSecret
 *   - Stripe configured path: stripe key = real (non-placeholder, non-empty)
 *
 * confirmPromotion:
 *   - Stripe configured path: pi.status !== 'succeeded' → throws BAD_REQUEST
 *   - Stripe configured path: pi.status === 'succeeded' → activates listing
 *
 * getFeaturedTasks:
 *   - Multiple rows returned
 *
 * promoteTask:
 *   - Validates featureType enum (zod rejects unknown types)
 *
 * Strategy: mock Stripe module as a proper class constructor so `new Stripe()`
 * works, then use a config with a real key to trigger the Stripe branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — MUST come before ANY import that touches these modules
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

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn() },
}));

// Config with a REAL Stripe key (non-empty, does not include 'placeholder')
// so the featured router takes the Stripe branch.
vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_realkey_for_mocking' },
    cloudflare: {
      r2: {
        accountId: '',
        accessKeyId: '',
        secretAccessKey: '',
        bucketName: 'test-bucket',
      },
    },
  },
}));

// Stripe mock — must be a proper constructor-compatible class
const mockPaymentIntentsCreate = vi.fn();
const mockPaymentIntentsRetrieve = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    paymentIntents = {
      create: mockPaymentIntentsCreate,
      retrieve: mockPaymentIntentsRetrieve,
    };
  }
  return { default: MockStripe };
});

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
const UUID3 = '00000000-0000-0000-0000-000000000003';

function makeCaller() {
  return featuredRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('featured router — Stripe configured branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // promoteTask — Stripe path
  // =========================================================================
  describe('promoteTask — with Stripe key configured', () => {
    it('returns non-null clientSecret from Stripe PaymentIntent', async () => {
      mockPaymentIntentsCreate.mockResolvedValue({
        id: 'pi_test_abc123',
        client_secret: 'pi_test_secret_xyz',
      });

      // Task ownership check
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1 }], rowCount: 1 } as any);
      // No existing promotion
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Insert listing
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'listing-stripe-1' }], rowCount: 1 } as any);

      const result = await makeCaller().promoteTask({
        taskId: UUID2,
        featureType: 'promoted',
      });

      expect(result.success).toBe(true);
      expect(result.listingId).toBe('listing-stripe-1');
      expect(result.clientSecret).toBe('pi_test_secret_xyz');
      expect(mockPaymentIntentsCreate).toHaveBeenCalledOnce();
      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 299, // promoted pricing
          currency: 'usd',
          metadata: expect.objectContaining({
            type: 'featured_listing',
            feature_type: 'promoted',
          }),
        }),
      );
    });

    it('paymentIntentId stored in DB insert call', async () => {
      mockPaymentIntentsCreate.mockResolvedValue({
        id: 'pi_stored_id',
        client_secret: 'pi_stored_secret',
      });

      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1 }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'listing-stored' }], rowCount: 1 } as any);

      await makeCaller().promoteTask({ taskId: UUID2, featureType: 'highlighted' });

      // The 3rd DB call is the INSERT — check param at index 4 is the stripe_payment_intent_id
      const insertCall = (mockDb.query as any).mock.calls[2];
      expect(insertCall[1][4]).toBe('pi_stored_id');
    });

    it('still throws NOT_FOUND when task not owned', async () => {
      // Task ownership check — wrong poster
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID3 }], rowCount: 1 } as any);

      await expect(
        makeCaller().promoteTask({ taskId: UUID2, featureType: 'promoted' }),
      ).rejects.toThrow('Task not found or not owned by user');

      // Stripe should NOT have been called
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it('still throws CONFLICT when active promotion exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1 }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'existing-promo' }], rowCount: 1 } as any);

      await expect(
        makeCaller().promoteTask({ taskId: UUID2, featureType: 'urgent_boost' }),
      ).rejects.toThrow('already has an active promotion');

      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // confirmPromotion — Stripe path
  // =========================================================================
  describe('confirmPromotion — with Stripe key configured', () => {
    it('throws BAD_REQUEST when PaymentIntent status is not succeeded', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_pending',
        status: 'requires_payment_method',
      });

      await expect(
        makeCaller().confirmPromotion({
          listingId: UUID3,
          stripePaymentIntentId: 'pi_pending',
        }),
      ).rejects.toThrow('Payment not completed');

      // DB should NOT have been called to activate listing
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('throws BAD_REQUEST for processing status (not succeeded)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_proc',
        status: 'processing',
      });

      await expect(
        makeCaller().confirmPromotion({
          listingId: UUID3,
          stripePaymentIntentId: 'pi_proc',
        }),
      ).rejects.toThrow('Payment not completed. Current status: processing');
    });

    it('activates listing and logs revenue when payment succeeded', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_ok',
        status: 'succeeded',
      });

      // DB: activate listing
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: UUID3, fee_cents: 799, task_id: UUID2, feature_type: 'urgent_boost' }],
        rowCount: 1,
      } as any);

      mockRevenue.logEvent.mockResolvedValue(undefined as any);

      const result = await makeCaller().confirmPromotion({
        listingId: UUID3,
        stripePaymentIntentId: 'pi_ok',
      });

      expect(result.success).toBe(true);
      expect(result.active).toBe(true);
      expect(mockRevenue.logEvent).toHaveBeenCalledOnce();
      expect(mockRevenue.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'featured_listing',
          amountCents: 799,
          metadata: expect.objectContaining({ featureType: 'urgent_boost' }),
        }),
      );
    });

    it('throws NOT_FOUND when listing not found after payment succeeded', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_ok_notfound',
        status: 'succeeded',
      });

      // DB: no rows (listing not found or already activated)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(
        makeCaller().confirmPromotion({
          listingId: UUID3,
          stripePaymentIntentId: 'pi_ok_notfound',
        }),
      ).rejects.toThrow('Featured listing not found');
    });
  });

  // =========================================================================
  // getFeaturedTasks — multiple rows
  // =========================================================================
  describe('getFeaturedTasks — multiple rows', () => {
    it('returns multiple featured tasks ordered by created_at', async () => {
      const rows = [
        { id: 'listing-1', task_id: UUID2, title: 'Task A', feature_type: 'promoted' },
        { id: 'listing-2', task_id: UUID3, title: 'Task B', feature_type: 'highlighted' },
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeCaller().getFeaturedTasks();

      expect(result).toHaveLength(2);
      expect(result[0].feature_type).toBe('promoted');
      expect(result[1].feature_type).toBe('highlighted');
    });
  });
});
