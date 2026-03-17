/**
 * Tipping Router Unit Tests
 *
 * Tests all tRPC procedures on the tipping router:
 * - createTip (protected, mutation)
 * - confirmTip (protected, mutation)
 * - getTipsForTask (protected, query)
 * - getMyTipsReceived (protected, query)
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

vi.mock('../../src/services/TippingService', () => ({
  TippingService: {
    createTip: vi.fn(),
    confirmTip: vi.fn(),
    getTipsForTask: vi.fn(),
    getTotalTipsReceived: vi.fn(),
    getTipsSentByUser: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { tippingRouter } from '../../src/routers/tipping';
import { TippingService } from '../../src/services/TippingService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(TippingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';
const TEST_UUID_2 = '22222222-2222-2222-2222-222222222222';

function makeCaller(userId = 'test-uid') {
  return tippingRouter.createCaller({
    user: { id: userId, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tipping.createTip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a tip successfully', async () => {
    const tipData = { id: TEST_UUID, amountCents: 500, clientSecret: 'cs_test' };
    mockService.createTip.mockResolvedValueOnce({ success: true, data: tipData } as any);

    const result = await makeCaller().createTip({ taskId: TEST_UUID_2, amountCents: 500 });

    expect(result).toEqual(tipData);
    expect(mockService.createTip).toHaveBeenCalledWith({
      taskId: TEST_UUID_2,
      posterId: 'test-uid',
      amountCents: 500,
    });
  });

  it('throws BAD_REQUEST when service fails', async () => {
    mockService.createTip.mockResolvedValueOnce({
      success: false,
      error: { message: 'Task not completed' },
    } as any);

    await expect(
      makeCaller().createTip({ taskId: TEST_UUID, amountCents: 500 })
    ).rejects.toThrow('Task not completed');
  });

  it('enforces minimum amount of 100 cents', async () => {
    await expect(
      makeCaller().createTip({ taskId: TEST_UUID, amountCents: 50 })
    ).rejects.toThrow();
  });

  it('enforces maximum amount of 50000 cents', async () => {
    await expect(
      makeCaller().createTip({ taskId: TEST_UUID, amountCents: 60000 })
    ).rejects.toThrow();
  });
});

describe('tipping.confirmTip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirms tip when caller is the poster', async () => {
    // Tip ownership check
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'test-uid' }],
      rowCount: 1,
    } as any);

    const confirmData = { confirmed: true };
    mockService.confirmTip.mockResolvedValueOnce({ success: true, data: confirmData } as any);

    const result = await makeCaller().confirmTip({
      tipId: TEST_UUID,
      stripePaymentIntentId: 'pi_test',
    });

    expect(result).toEqual(confirmData);
    expect(mockService.confirmTip).toHaveBeenCalledWith(TEST_UUID, 'pi_test');
  });

  it('throws NOT_FOUND when tip does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().confirmTip({ tipId: TEST_UUID, stripePaymentIntentId: 'pi_test' })
    ).rejects.toThrow('Tip not found');
  });

  it('throws FORBIDDEN when caller is not the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'other-user' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().confirmTip({ tipId: TEST_UUID, stripePaymentIntentId: 'pi_test' })
    ).rejects.toThrow('Not authorized to confirm this tip');
  });

  it('throws BAD_REQUEST when service fails', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'test-uid' }],
      rowCount: 1,
    } as any);
    mockService.confirmTip.mockResolvedValueOnce({
      success: false,
      error: { message: 'Payment not confirmed' },
    } as any);

    await expect(
      makeCaller().confirmTip({ tipId: TEST_UUID, stripePaymentIntentId: 'pi_test' })
    ).rejects.toThrow('Payment not confirmed');
  });
});

describe('tipping.getTipsForTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tips for a task', async () => {
    const tips = [{ id: TEST_UUID, amountCents: 500 }];
    mockService.getTipsForTask.mockResolvedValueOnce({ success: true, data: tips } as any);

    const result = await makeCaller().getTipsForTask({ taskId: TEST_UUID_2 });

    expect(result).toEqual(tips);
    expect(mockService.getTipsForTask).toHaveBeenCalledWith(TEST_UUID_2);
  });

  it('throws NOT_FOUND when service fails', async () => {
    mockService.getTipsForTask.mockResolvedValueOnce({
      success: false,
      error: { message: 'Task not found' },
    } as any);

    await expect(
      makeCaller().getTipsForTask({ taskId: TEST_UUID })
    ).rejects.toThrow('Task not found');
  });
});

describe('tipping.getMyTipsReceived', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns total tips received for user', async () => {
    const data = { totalCents: 5000, count: 10 };
    mockService.getTotalTipsReceived.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().getMyTipsReceived();

    expect(result).toEqual(data);
    expect(mockService.getTotalTipsReceived).toHaveBeenCalledWith('test-uid');
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockService.getTotalTipsReceived.mockResolvedValueOnce({
      success: false,
      error: { message: 'DB error' },
    } as any);

    await expect(makeCaller().getMyTipsReceived()).rejects.toThrow('DB error');
  });
});

describe('tipping.getMyTipsSent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tips sent by the current user', async () => {
    const data = [{ id: TEST_UUID, amountCents: 500, taskId: TEST_UUID_2 }];
    mockService.getTipsSentByUser.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().getMyTipsSent({ limit: 10, offset: 0 });

    expect(result).toEqual(data);
    expect(mockService.getTipsSentByUser).toHaveBeenCalledWith('test-uid', 10, 0);
  });

  it('uses default limit and offset', async () => {
    mockService.getTipsSentByUser.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeCaller().getMyTipsSent({});

    expect(mockService.getTipsSentByUser).toHaveBeenCalledWith('test-uid', 50, 0);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockService.getTipsSentByUser.mockResolvedValueOnce({
      success: false,
      error: { message: 'Failed to get tips sent' },
    } as any);

    await expect(makeCaller().getMyTipsSent({})).rejects.toThrow('Failed to get tips sent');
  });
});
