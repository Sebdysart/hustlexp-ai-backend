/**
 * XP Tax Router Unit Tests
 *
 * Tests all tRPC procedures:
 * - getTaxStatus (protected, query)
 * - getTaxHistory (protected, query)
 * - createPaymentIntent (protected, mutation)
 * - payTax (protected, mutation)
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

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: {
    checkTaxStatus: vi.fn(),
    getTaxHistory: vi.fn(),
    payTax: vi.fn(),
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: vi.fn(),
    createTaxPaymentIntent: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { xpTaxRouter } from '../../src/routers/xpTax';
import { XPTaxService } from '../../src/services/XPTaxService';
import { StripeService } from '../../src/services/StripeService';

const mockTaxService = vi.mocked(XPTaxService);
const mockStripeService = vi.mocked(StripeService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return xpTaxRouter.createCaller({
    user: { id: userId, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('xpTax.getTaxStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tax status from service', async () => {
    const status = { unpaid_tax_cents: 500, xp_held_back: 100 };
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({ success: true, data: status } as any);

    const result = await makeCaller().getTaxStatus();

    expect(result).toEqual(status);
    expect(mockTaxService.checkTaxStatus).toHaveBeenCalledWith('test-uid');
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({
      success: false,
      error: { message: 'DB error' },
    } as any);

    await expect(makeCaller().getTaxStatus()).rejects.toThrow('DB error');
  });
});

describe('xpTax.getTaxHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tax history with default limit', async () => {
    const history = [{ id: '1', amount: 500 }];
    mockTaxService.getTaxHistory.mockResolvedValueOnce({ success: true, data: history } as any);

    const result = await makeCaller().getTaxHistory();

    expect(result).toEqual(history);
    // When no input is provided, the optional input is undefined, so limit is undefined
    expect(mockTaxService.getTaxHistory).toHaveBeenCalledWith('test-uid', undefined);
  });

  it('passes custom limit', async () => {
    mockTaxService.getTaxHistory.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeCaller().getTaxHistory({ limit: 50 });

    expect(mockTaxService.getTaxHistory).toHaveBeenCalledWith('test-uid', 50);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockTaxService.getTaxHistory.mockResolvedValueOnce({
      success: false,
      error: { message: 'Failed' },
    } as any);

    await expect(makeCaller().getTaxHistory()).rejects.toThrow('Failed');
  });
});

describe('xpTax.createPaymentIntent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates payment intent when tax balance exists', async () => {
    mockStripeService.isConfigured.mockReturnValueOnce(true);
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({
      success: true,
      data: { unpaid_tax_cents: 500 },
    } as any);
    mockStripeService.createTaxPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: { clientSecret: 'cs_test', paymentIntentId: 'pi_test' },
    } as any);

    const result = await makeCaller().createPaymentIntent();

    expect(result.clientSecret).toBe('cs_test');
    expect(result.paymentIntentId).toBe('pi_test');
    expect(result.amountCents).toBe(500);
  });

  it('returns mock intent when Stripe not configured (dev/test)', async () => {
    mockStripeService.isConfigured.mockReturnValueOnce(false);
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({
      success: true,
      data: { unpaid_tax_cents: 300 },
    } as any);

    const result = await makeCaller().createPaymentIntent();

    expect(result.clientSecret).toContain('pi_tax_');
    expect(result.amountCents).toBe(300);
    expect(mockStripeService.createTaxPaymentIntent).not.toHaveBeenCalled();
  });

  it('throws INTERNAL_SERVER_ERROR when Stripe configured but createTaxPaymentIntent fails (F57-3)', async () => {
    mockStripeService.isConfigured.mockReturnValueOnce(true);
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({
      success: true,
      data: { unpaid_tax_cents: 300 },
    } as any);
    mockStripeService.createTaxPaymentIntent.mockResolvedValueOnce({
      success: false,
    } as any);

    await expect(makeCaller().createPaymentIntent()).rejects.toThrow('Failed to create tax payment intent');
  });

  it('throws BAD_REQUEST when no tax balance', async () => {
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({
      success: true,
      data: { unpaid_tax_cents: 0 },
    } as any);

    await expect(makeCaller().createPaymentIntent()).rejects.toThrow('No tax balance to pay');
  });

  it('throws INTERNAL_SERVER_ERROR when status check fails', async () => {
    mockTaxService.checkTaxStatus.mockResolvedValueOnce({ success: false } as any);

    await expect(makeCaller().createPaymentIntent()).rejects.toThrow('Failed to get tax status');
  });
});

describe('xpTax.payTax', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pays tax with stripe_payment_intent_id', async () => {
    mockTaxService.payTax.mockResolvedValueOnce({
      success: true,
      data: { xp_released: 100 },
    } as any);

    const result = await makeCaller().payTax({ stripe_payment_intent_id: 'pi_test' });

    expect(result.success).toBe(true);
    expect(result.xp_released).toBe(100);
    expect(mockTaxService.payTax).toHaveBeenCalledWith('test-uid', 'pi_test');
  });

  it('pays tax with paymentIntentId (alternate field)', async () => {
    mockTaxService.payTax.mockResolvedValueOnce({
      success: true,
      data: { xp_released: 50 },
    } as any);

    const result = await makeCaller().payTax({ paymentIntentId: 'pi_alt' });

    expect(result.success).toBe(true);
    expect(mockTaxService.payTax).toHaveBeenCalledWith('test-uid', 'pi_alt');
  });

  it('throws BAD_REQUEST when neither payment ID provided', async () => {
    await expect(makeCaller().payTax({})).rejects.toThrow(
      'stripe_payment_intent_id or paymentIntentId is required'
    );
  });

  it('throws BAD_REQUEST when service fails', async () => {
    mockTaxService.payTax.mockResolvedValueOnce({
      success: false,
      error: { message: 'Payment not verified' },
    } as any);

    await expect(
      makeCaller().payTax({ paymentIntentId: 'pi_test' })
    ).rejects.toThrow('Payment not verified');
  });
});
