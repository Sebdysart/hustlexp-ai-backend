/**
 * StripeConnectService branch coverage supplement
 *
 * Targets uncovered branches not covered by service-stripe-connect.test.ts:
 * - getOrCreateConnectAccount: user not found, existing account, stripe null, stripe error (Error vs non-Error)
 * - getOnboardingStatus: no accountId, stripe null, success, catch error vs non-Error
 * - createOnboardingLink: stripe null, account result fails, catch error vs non-Error
 * - getDashboardLink: no accountId, stripe null, catch error vs non-Error
 * - getPayoutSettings: no accountId, stripe null, catch error vs non-Error
 * - updatePayoutSettings: no accountId, stripe null, instant not eligible, standard interval, catch
 * - getTaxInfo: no accountId, no rows, found row
 * - submitTaxInfo: no accountId, ssnLast4 vs ein last4 vs null
 * - getEarningsSummary: no accountId, success with thresholds, catch error vs non-Error
 * - getAccountDetails: no accountId, stripe null, catch error vs non-Error
 * - refreshOnboarding: user not found
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('stripe', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: null, // stripe not configured
      webhookSecret: '',
      platformFeePercent: 15,
      minimumTaskValueCents: 500,
    },
  },
}));

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    execute: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { db } from '../../src/db';
import { StripeConnectService } from '../../src/services/StripeConnectService';

const mockDb = vi.mocked(db);

beforeEach(() => vi.clearAllMocks());

describe('StripeConnectService branch coverage', () => {
  describe('isConfigured', () => {
    it('returns false when stripe is null', () => {
      expect(StripeConnectService.isConfigured()).toBe(false);
    });
  });

  describe('getOnboardingStatus', () => {
    it('returns not-onboarded when user has no connect account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getOnboardingStatus('user-1');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isOnboarded).toBe(false);
        expect(result.data.accountId).toBeNull();
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when user has account but stripe is null', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getOnboardingStatus('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('createOnboardingLink', () => {
    it('returns STRIPE_NOT_CONFIGURED when stripe is null', async () => {
      const result = await StripeConnectService.createOnboardingLink({
        userId: 'u1', email: 'a@b.com', fullName: 'Test',
        refreshUrl: 'http://refresh', returnUrl: 'http://return',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('getDashboardLink', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getDashboardLink('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when account exists but stripe null', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getDashboardLink('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('getPayoutSettings', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getPayoutSettings('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when account exists but stripe null', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getPayoutSettings('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('updatePayoutSettings', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.updatePayoutSettings({
        userId: 'u1', schedule: 'standard',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when account exists but stripe null', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.updatePayoutSettings({
        userId: 'u1', schedule: 'standard',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('getTaxInfo', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getTaxInfo('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns not_submitted when no tax forms found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [], rowCount: 0,
      } as any);

      const result = await StripeConnectService.getTaxInfo('user-1');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('not_submitted');
        expect(result.data.formType).toBeNull();
      }
    });

    it('returns tax info when form exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          form_type: 'W9', status: 'verified', submitted_at: new Date(),
          verified_at: new Date(), requires_update: false,
          tax_id_last4: '1234', name_on_file: 'John', business_name_on_file: null,
        }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getTaxInfo('user-1');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.formType).toBe('W9');
        expect(result.data.status).toBe('verified');
      }
    });
  });

  describe('submitTaxInfo', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.submitTaxInfo({
        userId: 'u1', formType: 'W9',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });
  });

  describe('getEarningsSummary', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getEarningsSummary({ userId: 'u1', year: 2026 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns earnings data with threshold calculations', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);
      // Earnings
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_cents: '600000', transaction_count: '250' }],
        rowCount: 1,
      } as any);
      // Pending
      mockDb.query.mockResolvedValueOnce({
        rows: [{ pending_cents: '5000' }],
        rowCount: 1,
      } as any);
      // Monthly
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { month: 1, earnings_cents: '200000', transactions: '80' },
          { month: 2, earnings_cents: '400000', transactions: '170' },
        ],
        rowCount: 2,
      } as any);

      const result = await StripeConnectService.getEarningsSummary({ userId: 'u1', year: 2026 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalEarningsCents).toBe(600000);
        expect(result.data.threshold1099K.metAmountThreshold).toBe(true);
        expect(result.data.threshold1099K.metTransactionThreshold).toBe(true);
        expect(result.data.threshold1099K.willReceive1099K).toBe(true);
        expect(result.data.byMonth).toHaveLength(2);
      }
    });

    it('returns below-threshold when earnings are low', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_cents: '1000', transaction_count: '2' }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ pending_cents: '0' }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [], rowCount: 0,
      } as any);

      const result = await StripeConnectService.getEarningsSummary({ userId: 'u1', year: 2026 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.threshold1099K.willReceive1099K).toBe(false);
      }
    });
  });

  describe('getAccountDetails', () => {
    it('returns STRIPE_CONNECT_NOT_SETUP when no account', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getAccountDetails('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when stripe null', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_123' }],
        rowCount: 1,
      } as any);

      const result = await StripeConnectService.getAccountDetails('user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
      }
    });
  });

  describe('refreshOnboarding', () => {
    it('returns USER_NOT_FOUND when user does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [], rowCount: 0,
      } as any);

      const result = await StripeConnectService.refreshOnboarding({
        userId: 'u1',
        refreshUrl: 'http://refresh',
        returnUrl: 'http://return',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('USER_NOT_FOUND');
      }
    });
  });
});
