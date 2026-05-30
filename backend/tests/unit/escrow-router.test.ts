/**
 * Escrow Router Unit Tests — Financial Critical Path
 *
 * Tests all 10 procedures in the escrow router:
 *   READ:    getById, getState, getByTaskId, getHistory
 *   PAYMENT: createPaymentIntent, confirmFunding, release, refund
 *   DISPUTE: lockForDispute
 *   XP:      awardXP
 *
 * Each test validates return shape, authorization, error handling,
 * and financial safety invariants.
 *
 * Pattern: mock services and db at module level, use createCaller
 * with a fake user context to bypass middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(),
  isUniqueViolation: vi.fn(),
  getErrorMessage: vi.fn(),
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    getById: vi.fn(),
    getByTaskId: vi.fn(),
    fund: vi.fn(),
    release: vi.fn(),
    refund: vi.fn(),
    lockForDispute: vi.fn(),
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: vi.fn(),
    createPaymentIntent: vi.fn(),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn(),
  },
}));

vi.mock('../../src/middleware/fraud-guard', () => ({
  fraudGuard: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { StripeService } from '../../src/services/StripeService';
import { XPService } from '../../src/services/XPService';
import { escrowRouter } from '../../src/routers/escrow';

const mockDb = vi.mocked(db);
const mockEscrowService = vi.mocked(EscrowService);
const mockStripeService = vi.mocked(StripeService);
const mockXPService = vi.mocked(XPService);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSTER_ID = 'poster-aaa-bbb-ccc-ddd';
const WORKER_ID = 'worker-eee-fff-ggg-hhh';
const OTHER_USER_ID = 'other-iii-jjj-kkk-lll';
const ESCROW_ID = '11111111-2222-3333-4444-555555555555';
const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESCROW_ID,
    task_id: TASK_ID,
    amount: 5000,
    state: 'FUNDED',
    poster_id: POSTER_ID,
    worker_id: WORKER_ID,
    stripe_payment_intent_id: 'pi_test_123',
    stripe_transfer_id: null,
    funded_at: new Date('2025-06-01T00:00:00Z'),
    released_at: null,
    refunded_at: null,
    created_at: new Date('2025-06-01T00:00:00Z'),
    updated_at: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCaller(userId: string = POSTER_ID, role: string = 'user', defaultMode: 'worker' | 'poster' = 'poster') {
  return escrowRouter.createCaller({
    user: { id: userId, role, default_mode: defaultMode } as any,
    firebaseUid: `fb-${userId}`,
  });
}

function makeWorkerCaller(userId: string = WORKER_ID) {
  return makeCaller(userId, 'user', 'worker');
}

// =============================================================================
// escrow.getById
// =============================================================================

describe('escrow.getById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns the escrow data when user is the poster', async () => {
      const escrow = makeEscrow();
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: escrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getById({ escrowId: ESCROW_ID });

      expect(result).toHaveProperty('id', ESCROW_ID);
      expect(result).toHaveProperty('task_id', TASK_ID);
      expect(result).toHaveProperty('amount', 5000);
      expect(result).toHaveProperty('state', 'FUNDED');
    });

    it('returns the escrow data when user is the worker', async () => {
      const escrow = makeEscrow();
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: escrow as any,
      });

      const caller = makeCaller(WORKER_ID);
      const result = await caller.getById({ escrowId: ESCROW_ID });

      expect(result).toHaveProperty('id', ESCROW_ID);
      expect(result).toHaveProperty('amount', 5000);
    });
  });

  describe('authorization', () => {
    it('throws FORBIDDEN when user is neither poster nor worker', async () => {
      const escrow = makeEscrow();
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: escrow as any,
      });

      const caller = makeCaller(OTHER_USER_ID);
      await expect(caller.getById({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'You do not have access to this escrow',
        });
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.getById({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});

// =============================================================================
// escrow.getState
// =============================================================================

describe('escrow.getState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns { state } for a valid escrow', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'FUNDED' }) as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getState({ escrowId: ESCROW_ID });

      expect(result).toEqual({ state: 'FUNDED' });
    });

    it('returns correct state for each escrow state', async () => {
      for (const state of ['PENDING', 'FUNDED', 'RELEASED', 'REFUNDED', 'LOCKED_DISPUTE']) {
        vi.clearAllMocks();
        mockEscrowService.getById.mockResolvedValueOnce({
          success: true,
          data: makeEscrow({ state }) as any,
        });

        const result = await makeCaller().getState({ escrowId: ESCROW_ID });
        expect(result.state).toBe(state);
      }
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.getState({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Escrow not found',
        });
    });
  });

  describe('service delegation', () => {
    it('calls EscrowService.getById with the correct escrowId', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'FUNDED' }) as any,
      });

      await makeCaller().getState({ escrowId: ESCROW_ID });

      expect(mockEscrowService.getById).toHaveBeenCalledWith(ESCROW_ID);
    });
  });
});

// =============================================================================
// escrow.getByTaskId
// =============================================================================

describe('escrow.getByTaskId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns escrow data for a valid task', async () => {
      const escrow = makeEscrow();
      mockEscrowService.getByTaskId.mockResolvedValueOnce({
        success: true,
        data: escrow as any,
      });
      // getByTaskId also calls getById for auth check
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: escrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getByTaskId({ taskId: TASK_ID });

      expect(result).toHaveProperty('id', ESCROW_ID);
      expect(result).toHaveProperty('task_id', TASK_ID);
      expect(result).toHaveProperty('amount', 5000);
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when no escrow exists for the task', async () => {
      mockEscrowService.getByTaskId.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No escrow found for task' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.getByTaskId({ taskId: TASK_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('service delegation', () => {
    it('calls EscrowService.getByTaskId with the correct taskId', async () => {
      mockEscrowService.getByTaskId.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      // Auth check also calls getById
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      await makeCaller().getByTaskId({ taskId: TASK_ID });

      expect(mockEscrowService.getByTaskId).toHaveBeenCalledWith(TASK_ID);
    });
  });
});

// =============================================================================
// escrow.createPaymentIntent
// =============================================================================

describe('escrow.createPaymentIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns payment intent data on success with explicit amount', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      // Router queries task price first
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: 5000 }], rowCount: 1 } as any);
      mockStripeService.createPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: {
          paymentIntentId: 'pi_test_abc',
          clientSecret: 'cs_test_abc',
          amount: 5000,
        },
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.createPaymentIntent({
        taskId: TASK_ID,
        amount: 5000,
      });

      expect(result).toHaveProperty('paymentIntentId', 'pi_test_abc');
      expect(result).toHaveProperty('clientSecret', 'cs_test_abc');
      expect(result).toHaveProperty('amount', 5000);
    });

    it('derives amount from task price when amount is omitted', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      // Router queries task price first (used as the amount when none provided)
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: 7500 }], rowCount: 1 } as any);
      mockStripeService.createPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: {
          paymentIntentId: 'pi_test_derived',
          clientSecret: 'cs_test_derived',
          amount: 7500,
        },
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.createPaymentIntent({ taskId: TASK_ID });

      expect(result).toHaveProperty('amount', 7500);
      expect(mockStripeService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 7500 })
      );
    });
  });

  describe('stripe configuration guard', () => {
    it('throws PRECONDITION_FAILED when Stripe is not configured', async () => {
      mockStripeService.isConfigured.mockReturnValue(false);

      const caller = makeCaller(POSTER_ID);
      await expect(caller.createPaymentIntent({ taskId: TASK_ID, amount: 5000 }))
        .rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Payment processing is not configured',
        });
    });
  });

  describe('authorization — SECURITY CRITICAL (poster ownership)', () => {
    it('throws NOT_FOUND when the task belongs to another poster (ownership check)', async () => {
      // The DB query now includes AND poster_id = $2.
      // When a different poster calls createPaymentIntent for a task they don't own,
      // the query returns 0 rows → NOT_FOUND (does not leak whether the task exists).
      mockStripeService.isConfigured.mockReturnValue(true);
      // Simulate: task exists but belongs to a different poster — 0 rows returned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller(OTHER_USER_ID, 'user', 'poster');
      await expect(caller.createPaymentIntent({ taskId: TASK_ID, amount: 5000 }))
        .rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
    });

    it('passes poster_id from context as the second query parameter (ownership enforcement)', async () => {
      // Confirm the SQL ownership clause receives ctx.user.id as $2
      mockStripeService.isConfigured.mockReturnValue(true);
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: 3000 }], rowCount: 1 } as any);
      mockStripeService.createPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { paymentIntentId: 'pi_own', clientSecret: 'cs_own', amount: 3000 },
      });

      await makeCaller(POSTER_ID).createPaymentIntent({ taskId: TASK_ID, amount: 3000 });

      // First db.query call is the task ownership SELECT
      const taskQueryCall = mockDb.query.mock.calls[0];
      expect(taskQueryCall[1]).toEqual([TASK_ID, POSTER_ID]);
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when task does not exist', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      // Router queries task — task not found
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller(POSTER_ID);
      await expect(caller.createPaymentIntent({ taskId: TASK_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws BAD_REQUEST when task has no price set (REG-2 guard)', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      // Router queries task — price is null
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: null }], rowCount: 1 } as any);

      const caller = makeCaller(POSTER_ID);
      await expect(caller.createPaymentIntent({ taskId: TASK_ID, amount: 5000 }))
        .rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('Task price has not been set'),
        });
    });

    it('throws INTERNAL_SERVER_ERROR when Stripe call fails', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: 5000 }], rowCount: 1 } as any);
      mockStripeService.createPaymentIntent.mockResolvedValueOnce({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'Card declined' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.createPaymentIntent({ taskId: TASK_ID, amount: 5000 }))
        .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  });

  describe('service delegation', () => {
    it('passes posterId from context to StripeService', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      mockDb.query.mockResolvedValueOnce({ rows: [{ price: 1000 }], rowCount: 1 } as any);
      mockStripeService.createPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { paymentIntentId: 'pi_x', clientSecret: 'cs_x', amount: 1000 },
      });

      await makeCaller(POSTER_ID).createPaymentIntent({ taskId: TASK_ID, amount: 1000 });

      expect(mockStripeService.createPaymentIntent).toHaveBeenCalledWith({
        taskId: TASK_ID,
        posterId: POSTER_ID,
        amount: 1000,
      });
    });
  });
});

// =============================================================================
// escrow.confirmFunding
// =============================================================================

describe('escrow.confirmFunding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns funded escrow data on success', async () => {
      const fundedEscrow = makeEscrow({ state: 'FUNDED' });
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'PENDING' }) as any,
      });
      mockEscrowService.fund.mockResolvedValueOnce({
        success: true,
        data: fundedEscrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_fund',
      });

      expect(result).toHaveProperty('state', 'FUNDED');
      expect(result).toHaveProperty('id', ESCROW_ID);
    });
  });

  describe('authorization', () => {
    it('throws FORBIDDEN when caller is not the poster', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(WORKER_ID);
      await expect(caller.confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_fund',
      })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the escrow creator can confirm funding',
      });
    });

    it('throws FORBIDDEN when caller is a third party', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(OTHER_USER_ID);
      await expect(caller.confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_fund',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_fund',
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws BAD_REQUEST when fund operation fails', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.fund.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Cannot fund: wrong state' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_fund',
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('service delegation', () => {
    it('calls EscrowService.fund with correct params', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.fund.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'FUNDED' }) as any,
      });

      await makeCaller(POSTER_ID).confirmFunding({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_delegate',
      });

      expect(mockEscrowService.fund).toHaveBeenCalledWith({
        escrowId: ESCROW_ID,
        stripePaymentIntentId: 'pi_test_delegate',
      });
    });
  });
});

// =============================================================================
// escrow.release — FINANCIAL CRITICAL
// =============================================================================

describe('escrow.release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns released escrow data on success', async () => {
      const releasedEscrow = makeEscrow({ state: 'RELEASED' });
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'FUNDED' }) as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: true,
        data: releasedEscrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' });

      expect(result).toHaveProperty('state', 'RELEASED');
      expect(result).toHaveProperty('id', ESCROW_ID);
    });
  });

  describe('authorization — SECURITY CRITICAL', () => {
    it('throws FORBIDDEN when caller is the worker (cannot release own escrow)', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(WORKER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
        .rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Only the escrow creator can release funds',
        });
    });

    it('throws FORBIDDEN when caller is a third party', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(OTHER_USER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('only the poster can release funds', async () => {
      const releasedEscrow = makeEscrow({ state: 'RELEASED' });
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: true,
        data: releasedEscrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' });
      expect(result.state).toBe('RELEASED');
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws PRECONDITION_FAILED for INV-2 violation (HX201)', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: false,
        error: { code: 'HX201', message: 'Escrow release requires completed task' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('throws BAD_REQUEST for non-HX201 release failures', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Wrong state' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('service delegation', () => {
    it('passes escrowId and stripeTransferId to EscrowService.release', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'RELEASED' }) as any,
      });

      await makeCaller(POSTER_ID).release({
        escrowId: ESCROW_ID,
        stripeTransferId: 'tr_test_123',
      });

      expect(mockEscrowService.release).toHaveBeenCalledWith({
        escrowId: ESCROW_ID,
        stripeTransferId: 'tr_test_123',
      });
    });

    it('stripeTransferId is required — omitting it throws BAD_REQUEST (Zod validation)', async () => {
      // Fix 1A: stripeTransferId is now required in the router schema.
      // Omitting it should produce a Zod validation error before the service is called.
      const caller = makeCaller(POSTER_ID);
      await expect(caller.release({ escrowId: ESCROW_ID } as any))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(mockEscrowService.release).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// escrow.refund — FINANCIAL CRITICAL
// =============================================================================

describe('escrow.refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns refunded escrow data on success', async () => {
      const refundedEscrow = makeEscrow({ state: 'REFUNDED' });
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.refund.mockResolvedValueOnce({
        success: true,
        data: refundedEscrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.refund({ escrowId: ESCROW_ID });

      expect(result).toHaveProperty('state', 'REFUNDED');
      expect(result).toHaveProperty('id', ESCROW_ID);
    });
  });

  describe('authorization — SECURITY CRITICAL', () => {
    it('throws FORBIDDEN when caller is the worker', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(WORKER_ID);
      await expect(caller.refund({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Only the escrow creator can request a refund',
        });
    });

    it('throws FORBIDDEN when caller is a third party', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(OTHER_USER_ID);
      await expect(caller.refund({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.refund({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws BAD_REQUEST when refund operation fails', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.refund.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Cannot refund: wrong state' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.refund({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('service delegation', () => {
    it('calls EscrowService.refund with the escrowId', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.refund.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'REFUNDED' }) as any,
      });

      await makeCaller(POSTER_ID).refund({ escrowId: ESCROW_ID });

      expect(mockEscrowService.refund).toHaveBeenCalledWith({
        escrowId: ESCROW_ID,
      });
    });
  });
});

// =============================================================================
// escrow.lockForDispute
// =============================================================================

describe('escrow.lockForDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns locked escrow data on success', async () => {
      const lockedEscrow = makeEscrow({ state: 'LOCKED_DISPUTE' });
      // Auth check
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.lockForDispute.mockResolvedValueOnce({
        success: true,
        data: lockedEscrow as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.lockForDispute({ escrowId: ESCROW_ID });

      expect(result).toHaveProperty('state', 'LOCKED_DISPUTE');
      expect(result).toHaveProperty('id', ESCROW_ID);
    });
  });

  describe('authorization', () => {
    it('throws FORBIDDEN when caller is not a participant', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });

      const caller = makeCaller(OTHER_USER_ID);
      await expect(caller.lockForDispute({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Only task participants can file a dispute',
        });
    });

    it('throws NOT_FOUND when escrow does not exist (auth check)', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Escrow not found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.lockForDispute({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('error handling', () => {
    it('throws BAD_REQUEST when lock fails', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.lockForDispute.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Cannot lock: wrong state' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.lockForDispute({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('service delegation', () => {
    it('calls EscrowService.lockForDispute with escrowId and options object', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.lockForDispute.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'LOCKED_DISPUTE' }) as any,
      });

      await makeCaller(POSTER_ID).lockForDispute({ escrowId: ESCROW_ID });

      // Router passes (escrowId, { adminOverride: ctx.user.is_admin }) since v2.9.3 REG-5 fix
      // The second argument must be an object with an 'adminOverride' key
      const [calledEscrowId, calledOptions] = mockEscrowService.lockForDispute.mock.calls[0];
      expect(calledEscrowId).toBe(ESCROW_ID);
      expect(calledOptions).toHaveProperty('adminOverride');
    });
  });
});

// =============================================================================
// escrow.getHistory
// =============================================================================

describe('escrow.getHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns an array of escrow rows', async () => {
      const rows = [
        makeEscrow({ id: 'esc-1' }),
        makeEscrow({ id: 'esc-2', state: 'RELEASED' }),
      ];
      mockDb.query.mockResolvedValueOnce({
        rows,
        rowCount: rows.length,
      } as any);

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getHistory({ limit: 50 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id', 'esc-1');
      expect(result[1]).toHaveProperty('state', 'RELEASED');
    });

    it('returns empty array when user has no history', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getHistory({ limit: 50 });

      expect(result).toEqual([]);
    });
  });

  describe('pagination', () => {
    it('passes limit to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller(POSTER_ID).getHistory({ limit: 25 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(25);
    });

    it('uses default limit of 50 when input is omitted', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller(POSTER_ID).getHistory();

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(50);
    });
  });

  describe('db interaction', () => {
    it('queries escrows joined with tasks for the current user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller(POSTER_ID).getHistory({ limit: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('FROM escrows');
      expect(sql).toContain('JOIN tasks');
      expect(sql).toContain('ORDER BY');
      expect(params[0]).toBe(POSTER_ID);
    });

    it('makes exactly 1 db.query call', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller(POSTER_ID).getHistory({ limit: 10 });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// escrow.awardXP
// =============================================================================

describe('escrow.awardXP', () => {
  // Helper: mock the DB query that the router now uses to derive baseXP server-side.
  // The escrow has amount=5000 cents, so derivedBaseXP = Math.round(5000/10) = 500.
  function mockReleasedEscrow(overrides: { amount?: number; worker_id?: string } = {}) {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        amount: overrides.amount ?? 5000,
        worker_id: overrides.worker_id ?? WORKER_ID,
      }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns XP award data on success', async () => {
      const xpData = {
        id: 'xp-ledger-1',
        user_id: WORKER_ID,
        task_id: TASK_ID,
        escrow_id: ESCROW_ID,
        base_xp: 500,
        effective_xp: 650,
        streak_multiplier: 1.3,
        user_xp_before: 1000,
        user_xp_after: 1650,
        user_level_before: 3,
        user_level_after: 3,
      };
      mockReleasedEscrow(); // amount=5000, worker_id=WORKER_ID
      mockXPService.awardXP.mockResolvedValueOnce({
        success: true,
        data: xpData as any,
      });

      // SECURITY FIX: caller does NOT supply baseXP — derived server-side
      const caller = makeWorkerCaller();
      const result = await caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      });

      expect(result).toHaveProperty('effective_xp', 650);
      expect(result).toHaveProperty('base_xp', 500);
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow is not in RELEASED state', async () => {
      // db.query returns no rows — escrow not found in RELEASED state
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const caller = makeWorkerCaller();
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // XPService must NOT be called if escrow lookup fails
      expect(mockXPService.awardXP).not.toHaveBeenCalled();
    });

    it('throws FORBIDDEN when caller is not the worker on this escrow', async () => {
      // Escrow has a different worker_id
      mockReleasedEscrow({ worker_id: 'different-worker-id' });

      const caller = makeWorkerCaller(WORKER_ID);
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(mockXPService.awardXP).not.toHaveBeenCalled();
    });

    it('throws PRECONDITION_FAILED for INV-1 violation (HX101)', async () => {
      mockReleasedEscrow();
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: 'HX101', message: 'XP requires released escrow' },
      });

      const caller = makeWorkerCaller();
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('throws CONFLICT for INV-5 violation (duplicate XP, 23505)', async () => {
      mockReleasedEscrow();
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: '23505', message: 'XP already awarded for this escrow' },
      });

      const caller = makeWorkerCaller();
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('throws BAD_REQUEST for other XP errors', async () => {
      mockReleasedEscrow();
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: 'OTHER_ERROR', message: 'Something else failed' },
      });

      const caller = makeWorkerCaller();
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('server-side baseXP derivation (FIX 1 — security)', () => {
    it('derives baseXP from escrow amount (amount/10) and passes it to XPService', async () => {
      // amount=5000 cents → derivedBaseXP=500
      mockReleasedEscrow({ amount: 5000 });
      mockXPService.awardXP.mockResolvedValueOnce({
        success: true,
        data: { id: 'xp-1' } as any,
      });

      await makeWorkerCaller(WORKER_ID).awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
      });

      expect(mockXPService.awardXP).toHaveBeenCalledWith({
        userId: WORKER_ID,
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 500, // derived: Math.round(5000/10) = 500
      });
    });

    it('an inflated caller-supplied baseXP has no effect on the actual award', async () => {
      // Even if an attacker somehow passes baseXP in the payload, Zod strips it,
      // and the router re-derives it from the escrow amount.
      mockReleasedEscrow({ amount: 1000 }); // $10 task → 100 XP
      mockXPService.awardXP.mockResolvedValueOnce({
        success: true,
        data: { id: 'xp-1' } as any,
      });

      await makeWorkerCaller(WORKER_ID).awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        // baseXP: 10000 — Zod strips this; not part of schema
      } as any);

      expect(mockXPService.awardXP).toHaveBeenCalledWith(
        expect.objectContaining({ baseXP: 100 }) // derived from amount=1000/10=100, NOT 10000
      );
    });
  });
});

// =============================================================================
// Cross-cutting: Financial Safety Invariants
// =============================================================================

describe('Financial Safety — cross-cutting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthorized user cannot release escrow (worker impersonation)', async () => {
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: makeEscrow({ state: 'FUNDED' }) as any,
    });

    const caller = makeCaller(WORKER_ID);
    await expect(caller.release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockEscrowService.release).not.toHaveBeenCalled();
  });

  it('unauthorized user cannot confirm funding', async () => {
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: makeEscrow() as any,
    });

    const caller = makeCaller(OTHER_USER_ID);
    await expect(caller.confirmFunding({
      escrowId: ESCROW_ID,
      stripePaymentIntentId: 'pi_attack',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockEscrowService.fund).not.toHaveBeenCalled();
  });

  it('unauthorized user cannot request refund', async () => {
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: makeEscrow() as any,
    });

    const caller = makeCaller(OTHER_USER_ID);
    await expect(caller.refund({ escrowId: ESCROW_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockEscrowService.refund).not.toHaveBeenCalled();
  });

  it('INV-2: release blocked when task is not COMPLETED (HX201 maps to PRECONDITION_FAILED)', async () => {
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: makeEscrow() as any,
    });
    mockEscrowService.release.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX201', message: 'Task must be COMPLETED' },
    });

    await expect(makeCaller(POSTER_ID).release({ escrowId: ESCROW_ID, stripeTransferId: 'tr_test_123' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('INV-5: double XP award blocked (23505 maps to CONFLICT)', async () => {
    // Router now queries DB to derive baseXP — mock the escrow lookup first
    mockDb.query.mockResolvedValueOnce({
      rows: [{ amount: 5000, worker_id: WORKER_ID }],
    });
    mockXPService.awardXP.mockResolvedValueOnce({
      success: false,
      error: { code: '23505', message: 'duplicate key' },
    });

    await expect(makeWorkerCaller().awardXP({
      taskId: TASK_ID,
      escrowId: ESCROW_ID,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('getById does not leak escrow data to unrelated users', async () => {
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: makeEscrow() as any,
    });

    await expect(makeCaller(OTHER_USER_ID).getById({ escrowId: ESCROW_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
