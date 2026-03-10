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

function makeCaller(userId: string = POSTER_ID, role: string = 'user') {
  return escrowRouter.createCaller({
    user: { id: userId, role } as any,
    firebaseUid: `fb-${userId}`,
  });
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
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'FUNDED' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller(POSTER_ID);
      const result = await caller.getState({ escrowId: ESCROW_ID });

      expect(result).toEqual({ state: 'FUNDED' });
    });

    it('returns correct state for each escrow state', async () => {
      for (const state of ['PENDING', 'FUNDED', 'RELEASED', 'REFUNDED', 'LOCKED_DISPUTE']) {
        vi.clearAllMocks();
        mockDb.query.mockResolvedValueOnce({
          rows: [{ state }],
          rowCount: 1,
        } as any);

        const result = await makeCaller().getState({ escrowId: ESCROW_ID });
        expect(result.state).toBe(state);
      }
    });
  });

  describe('error handling', () => {
    it('throws NOT_FOUND when escrow does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const caller = makeCaller(POSTER_ID);
      await expect(caller.getState({ escrowId: ESCROW_ID }))
        .rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Escrow not found',
        });
    });
  });

  describe('db interaction', () => {
    it('queries the escrows table with the correct escrowId', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'FUNDED' }],
        rowCount: 1,
      } as any);

      await makeCaller().getState({ escrowId: ESCROW_ID });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('SELECT state FROM escrows');
      expect(params).toEqual([ESCROW_ID]);
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

    it('derives amount from task when amount is omitted', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      mockEscrowService.getByTaskId.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ amount: 7500 }) as any,
      });
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

  describe('error handling', () => {
    it('throws NOT_FOUND when amount is omitted and task has no escrow', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
      mockEscrowService.getByTaskId.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No escrow found' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.createPaymentIntent({ taskId: TASK_ID }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws INTERNAL_SERVER_ERROR when Stripe call fails', async () => {
      mockStripeService.isConfigured.mockReturnValue(true);
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
      const result = await caller.release({ escrowId: ESCROW_ID });

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
      await expect(caller.release({ escrowId: ESCROW_ID }))
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
      await expect(caller.release({ escrowId: ESCROW_ID }))
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
      const result = await caller.release({ escrowId: ESCROW_ID });
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
      await expect(caller.release({ escrowId: ESCROW_ID }))
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
      await expect(caller.release({ escrowId: ESCROW_ID }))
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
      await expect(caller.release({ escrowId: ESCROW_ID }))
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

    it('allows stripeTransferId to be omitted', async () => {
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as any,
      });
      mockEscrowService.release.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'RELEASED' }) as any,
      });

      await makeCaller(POSTER_ID).release({ escrowId: ESCROW_ID });

      expect(mockEscrowService.release).toHaveBeenCalledWith({
        escrowId: ESCROW_ID,
      });
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

  describe('error handling', () => {
    it('throws BAD_REQUEST when lock fails', async () => {
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
    it('calls EscrowService.lockForDispute with the escrowId', async () => {
      mockEscrowService.lockForDispute.mockResolvedValueOnce({
        success: true,
        data: makeEscrow({ state: 'LOCKED_DISPUTE' }) as any,
      });

      await makeCaller(POSTER_ID).lockForDispute({ escrowId: ESCROW_ID });

      expect(mockEscrowService.lockForDispute).toHaveBeenCalledWith(ESCROW_ID);
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns XP award data on success', async () => {
      const xpData = {
        id: 'xp-ledger-1',
        user_id: POSTER_ID,
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
      mockXPService.awardXP.mockResolvedValueOnce({
        success: true,
        data: xpData as any,
      });

      const caller = makeCaller(POSTER_ID);
      const result = await caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 500,
      });

      expect(result).toHaveProperty('effective_xp', 650);
      expect(result).toHaveProperty('base_xp', 500);
    });
  });

  describe('error handling', () => {
    it('throws PRECONDITION_FAILED for INV-1 violation (HX101)', async () => {
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: 'HX101', message: 'XP requires released escrow' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 500,
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('throws CONFLICT for INV-5 violation (duplicate XP, 23505)', async () => {
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: '23505', message: 'XP already awarded for this escrow' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 500,
      })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('throws BAD_REQUEST for other XP errors', async () => {
      mockXPService.awardXP.mockResolvedValueOnce({
        success: false,
        error: { code: 'OTHER_ERROR', message: 'Something else failed' },
      });

      const caller = makeCaller(POSTER_ID);
      await expect(caller.awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 500,
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('service delegation', () => {
    it('passes userId from context and input params to XPService', async () => {
      mockXPService.awardXP.mockResolvedValueOnce({
        success: true,
        data: { id: 'xp-1' } as any,
      });

      await makeCaller(POSTER_ID).awardXP({
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 750,
      });

      expect(mockXPService.awardXP).toHaveBeenCalledWith({
        userId: POSTER_ID,
        taskId: TASK_ID,
        escrowId: ESCROW_ID,
        baseXP: 750,
      });
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
    await expect(caller.release({ escrowId: ESCROW_ID }))
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

    await expect(makeCaller(POSTER_ID).release({ escrowId: ESCROW_ID }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('INV-5: double XP award blocked (23505 maps to CONFLICT)', async () => {
    mockXPService.awardXP.mockResolvedValueOnce({
      success: false,
      error: { code: '23505', message: 'duplicate key' },
    });

    await expect(makeCaller(POSTER_ID).awardXP({
      taskId: TASK_ID,
      escrowId: ESCROW_ID,
      baseXP: 500,
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
