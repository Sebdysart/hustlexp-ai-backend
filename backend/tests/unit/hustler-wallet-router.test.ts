import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));
vi.mock('../../src/config', () => ({
  config: { stripe: { secretKey: 'sk_test_placeholder' } },
}));

const { getOverview, reviewCashOut, requestCashOut } = vi.hoisted(() => ({
  getOverview: vi.fn(),
  reviewCashOut: vi.fn(),
  requestCashOut: vi.fn(),
}));

vi.mock('../../src/services/HustlerWalletService', () => ({
  HustlerWalletService: { getOverview, reviewCashOut, requestCashOut },
}));

import { hustlerWalletRouter } from '../../src/routers/hustlerWallet';

function makeCaller() {
  return hustlerWalletRouter.createCaller({
    user: {
      id: 'user-abc-123',
      email: 'worker@hustlexp.com',
      full_name: 'Test Worker',
      role: 'worker',
      default_mode: 'worker',
      firebase_uid: 'fb-worker-123',
    } as any,
    firebaseUid: 'fb-worker-123',
  });
}

function makeUnauthenticatedCaller() {
  return hustlerWalletRouter.createCaller({ user: null, firebaseUid: null } as any);
}

describe('Hustler wallet router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only the authenticated Hustler wallet', async () => {
    const wallet = {
      currency: 'usd',
      balances: { availableToCashOutCents: 5000 },
      availability: { status: 'available' },
    };
    getOverview.mockResolvedValue({ success: true, data: wallet });
    await expect(makeCaller().getOverview()).resolves.toEqual(wallet);
    expect(getOverview).toHaveBeenCalledWith('user-abc-123');
    await expect(makeUnauthenticatedCaller().getOverview()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('reviews exact amount without mutating provider state', async () => {
    const review = { eligible: true, amountCents: 5000, feeCents: 0, netCents: 5000 };
    reviewCashOut.mockResolvedValue({ success: true, data: review });
    await expect(makeCaller().reviewCashOut({ amountCents: 5000 })).resolves.toEqual(review);
    expect(reviewCashOut).toHaveBeenCalledWith('user-abc-123', 5000);
  });

  it('requires explicit idempotent confirmation and maps eligibility failures', async () => {
    requestCashOut.mockResolvedValueOnce({
      success: true,
      data: { id: 'req-1', state: 'submitted', amountCents: 5000 },
    });
    await expect(makeCaller().requestCashOut({
      amountCents: 5000,
      idempotencyKey: 'cashout-key-1',
    })).resolves.toMatchObject({ state: 'submitted' });
    expect(requestCashOut).toHaveBeenCalledWith({
      workerId: 'user-abc-123',
      amountCents: 5000,
      idempotencyKey: 'cashout-key-1',
    });

    requestCashOut.mockResolvedValueOnce({
      success: false,
      error: { code: 'ACTIVE_CASH_OUT', message: 'Another bank payout is already underway.' },
    });
    await expect(makeCaller().requestCashOut({
      amountCents: 5000,
      idempotencyKey: 'cashout-key-2',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('keeps unexpected service failures internal', async () => {
    getOverview.mockResolvedValue({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Wallet unavailable.' },
    });
    await expect(makeCaller().getOverview()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
