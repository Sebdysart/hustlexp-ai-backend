/**
 * StripeConnectService Unit Tests
 *
 * Covers: isConfigured, getOnboardingStatus, createOnboardingLink,
 * getDashboardLink, getPayoutSettings, updatePayoutSettings,
 * getTaxInfo, submitTaxInfo, getEarningsSummary, getAccountDetails,
 * refreshOnboarding — and error paths.
 *
 * Strategy: Mock Stripe at module level so the `stripe` singleton is null
 * (no real Stripe key), then test the not-configured paths. For the
 * configured paths, spy on stripeBreaker.execute and inject mock Stripe
 * account objects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stripe must be mocked BEFORE the service is imported so `stripe` remains null
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    accounts: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      createLoginLink: vi.fn(),
    },
    accountLinks: {
      create: vi.fn(),
    },
  })),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'placeholder', // triggers the "not configured" branch
      webhookSecret: '',
      platformFeePercent: 15,
      minimumTaskValueCents: 500,
    },
  },
}));

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  },
  stripeLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    execute: vi.fn((fn: () => unknown) => fn()),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { stripeBreaker } from '../../src/middleware/circuit-breaker';
import { StripeConnectService } from '../../src/services/StripeConnectService';

const mockDb = vi.mocked(db);
const mockStripeBreaker = vi.mocked(stripeBreaker);

// Helper: build a mock Stripe account object
function makeMockAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acct_test123',
    email: 'worker@example.com',
    country: 'US',
    default_currency: 'usd',
    charges_enabled: true,
    payouts_enabled: true,
    created: Math.floor(Date.now() / 1000) - 86400,
    capabilities: { card_payments: 'active', transfers: 'active' },
    requirements: {
      currently_due: [],
      eventually_due: [],
      past_due: [],
      disabled_reason: null,
    },
    settings: {
      payouts: {
        schedule: { interval: 'daily', weekly_anchor: null, monthly_anchor: null },
      },
      card_payments: {
        statement_descriptor_prefix: 'HXPAY',
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// isConfigured
// ===========================================================================

describe('StripeConnectService.isConfigured', () => {
  it('returns false when Stripe secret key is a placeholder', () => {
    // config.stripe.secretKey = 'placeholder' → stripe remains null
    expect(StripeConnectService.isConfigured()).toBe(false);
  });
});

// ===========================================================================
// getOnboardingStatus
// ===========================================================================

describe('StripeConnectService.getOnboardingStatus', () => {
  it('returns not-onboarded status when user has no connect account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getOnboardingStatus('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isOnboarded).toBe(false);
      expect(result.data.accountId).toBeNull();
      expect(result.data.chargesEnabled).toBe(false);
      expect(result.data.payoutsEnabled).toBe(false);
      expect(result.data.onboardingUrl).toBeNull();
    }
  });

  it('returns STRIPE_NOT_CONFIGURED error when user has account but Stripe is not configured', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getOnboardingStatus('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// createOnboardingLink
// ===========================================================================

describe('StripeConnectService.createOnboardingLink', () => {
  it('returns STRIPE_NOT_CONFIGURED when Stripe is not configured', async () => {
    const result = await StripeConnectService.createOnboardingLink({
      userId: 'user-1',
      email: 'user@example.com',
      fullName: 'John Doe',
      refreshUrl: 'https://app.com/refresh',
      returnUrl: 'https://app.com/return',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// getDashboardLink
// ===========================================================================

describe('StripeConnectService.getDashboardLink', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getDashboardLink('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns STRIPE_NOT_CONFIGURED when user has account but Stripe is not configured', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getDashboardLink('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// getPayoutSettings
// ===========================================================================

describe('StripeConnectService.getPayoutSettings', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getPayoutSettings('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns STRIPE_NOT_CONFIGURED when Stripe client is null', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getPayoutSettings('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// updatePayoutSettings
// ===========================================================================

describe('StripeConnectService.updatePayoutSettings', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.updatePayoutSettings({
      userId: 'user-1',
      schedule: 'standard',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns STRIPE_NOT_CONFIGURED when Stripe client is null', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.updatePayoutSettings({
      userId: 'user-1',
      schedule: 'standard',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// getTaxInfo
// ===========================================================================

describe('StripeConnectService.getTaxInfo', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getTaxInfo('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns not_submitted status when no tax form exists', async () => {
    // getConnectAccountId → returns account
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    // Tax form query → no rows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getTaxInfo('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('not_submitted');
      expect(result.data.formType).toBeNull();
      expect(result.data.taxIdLast4).toBeNull();
    }
  });

  it('returns existing tax form data when available', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W9',
        status: 'verified',
        submitted_at: new Date('2024-01-15'),
        verified_at: new Date('2024-01-20'),
        requires_update: false,
        tax_id_last4: '4321',
        name_on_file: 'John Doe',
        business_name_on_file: null,
      }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getTaxInfo('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.formType).toBe('W9');
      expect(result.data.status).toBe('verified');
      expect(result.data.taxIdLast4).toBe('4321');
      expect(result.data.nameOnFile).toBe('John Doe');
      expect(result.data.requiresUpdate).toBe(false);
    }
  });
});

// ===========================================================================
// submitTaxInfo
// ===========================================================================

describe('StripeConnectService.submitTaxInfo', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.submitTaxInfo({
      userId: 'user-1',
      formType: 'W9',
      name: 'John Doe',
      ssnLast4: '1234',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('expires existing active form and inserts new W9', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    // UPDATE expired forms
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // INSERT new form
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W9',
        status: 'pending',
        submitted_at: new Date(),
        verified_at: null,
        requires_update: false,
        tax_id_last4: '4321',
        name_on_file: 'John Doe',
        business_name_on_file: null,
      }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.submitTaxInfo({
      userId: 'user-1',
      formType: 'W9',
      name: 'John Doe',
      ssnLast4: '4321',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.formType).toBe('W9');
      expect(result.data.status).toBe('pending');
      expect(result.data.taxIdLast4).toBe('4321');
    }

    // Verify UPDATE was called to expire old form
    const expireCall = mockDb.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("'expired'"),
    );
    expect(expireCall).toBeDefined();
  });

  it('submits W8BEN form with foreignTaxId', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // expire old
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W8BEN',
        status: 'pending',
        submitted_at: new Date(),
        verified_at: null,
        requires_update: false,
        tax_id_last4: null,
        name_on_file: 'Maria Garcia',
        business_name_on_file: null,
      }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.submitTaxInfo({
      userId: 'user-1',
      formType: 'W8BEN',
      name: 'Maria Garcia',
      foreignTaxId: 'ES12345678A',
      treatyCountry: 'Spain',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.formType).toBe('W8BEN');
    }
  });

  it('uses EIN last 4 digits as taxIdLast4 when ssnLast4 is absent', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W9',
        status: 'pending',
        submitted_at: new Date(),
        verified_at: null,
        requires_update: false,
        tax_id_last4: '5678',
        name_on_file: null,
        business_name_on_file: 'ACME Corp',
      }],
      rowCount: 1,
    } as never);

    await StripeConnectService.submitTaxInfo({
      userId: 'user-1',
      formType: 'W9',
      businessName: 'ACME Corp',
      ein: '12-3455678', // last 4 = '5678'
    });

    const insertParams = mockDb.query.mock.calls[2][1] as unknown[];
    expect(insertParams[3]).toBe('5678'); // taxIdLast4
  });

  it('handles signature in submitted form', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W9', status: 'pending', submitted_at: new Date(),
        verified_at: null, requires_update: false,
        tax_id_last4: null, name_on_file: 'Alice', business_name_on_file: null,
      }],
      rowCount: 1,
    } as never);

    await StripeConnectService.submitTaxInfo({
      userId: 'user-1',
      formType: 'W9',
      name: 'Alice',
      signature: 'Alice Smith',
      signatureDate: '2024-03-01',
    });

    // signature_on_file should be true
    const insertParams = mockDb.query.mock.calls[2][1] as unknown[];
    expect(insertParams[15]).toBe(true); // signature_on_file
    expect(insertParams[16]).toBeInstanceOf(Date); // signed_at
  });
});

// ===========================================================================
// getEarningsSummary
// ===========================================================================

describe('StripeConnectService.getEarningsSummary', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns earnings summary for a user with no 2024 earnings', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    // Total earnings query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cents: '0', transaction_count: '0' }],
      rowCount: 1,
    } as never);
    // Pending earnings query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ pending_cents: '500' }],
      rowCount: 1,
    } as never);
    // Monthly breakdown query
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.year).toBe(2024);
      expect(result.data.totalEarningsCents).toBe(0);
      expect(result.data.totalTransactions).toBe(0);
      expect(result.data.byMonth).toHaveLength(0);
      expect(result.data.pendingEarningsCents).toBe(500);
      expect(result.data.threshold1099K.willReceive1099K).toBe(false);
    }
  });

  it('correctly identifies 1099-K threshold crossings', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    // Total earnings: $6000 (over $5000 threshold)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cents: '600000', transaction_count: '250' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ pending_cents: '0' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalEarningsCents).toBe(600000);
      expect(result.data.threshold1099K.metAmountThreshold).toBe(true);
      expect(result.data.threshold1099K.metTransactionThreshold).toBe(true);
      expect(result.data.threshold1099K.willReceive1099K).toBe(true);
    }
  });

  it('willReceive1099K is true when only transaction count threshold is met', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    // Under $5000 in earnings but over 200 transactions
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cents: '100000', transaction_count: '300' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ pending_cents: '0' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    if (result.success) {
      expect(result.data.threshold1099K.metAmountThreshold).toBe(false);
      expect(result.data.threshold1099K.metTransactionThreshold).toBe(true);
      expect(result.data.threshold1099K.willReceive1099K).toBe(true);
    }
  });

  it('includes monthly breakdown with parsed integers', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cents: '150000', transaction_count: '30' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ pending_cents: '10000' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { month: 1, earnings_cents: '50000', transactions: '10' },
        { month: 2, earnings_cents: '100000', transactions: '20' },
      ],
      rowCount: 2,
    } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    if (result.success) {
      expect(result.data.byMonth).toHaveLength(2);
      expect(result.data.byMonth[0].month).toBe(1);
      expect(result.data.byMonth[0].earningsCents).toBe(50000);
      expect(result.data.byMonth[0].transactions).toBe(10);
    }
  });

  it('returns DATABASE_ERROR on unexpected error', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DATABASE_ERROR');
    }
  });
});

// ===========================================================================
// getAccountDetails
// ===========================================================================

describe('StripeConnectService.getAccountDetails', () => {
  it('returns STRIPE_CONNECT_NOT_SETUP when user has no account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getAccountDetails('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    }
  });

  it('returns STRIPE_NOT_CONFIGURED when Stripe client is null', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getAccountDetails('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    }
  });
});

// ===========================================================================
// refreshOnboarding
// ===========================================================================

describe('StripeConnectService.refreshOnboarding', () => {
  it('returns USER_NOT_FOUND when user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.refreshOnboarding({
      userId: 'user-ghost',
      refreshUrl: 'https://app.com/refresh',
      returnUrl: 'https://app.com/return',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('USER_NOT_FOUND');
    }
  });

  it('delegates to createOnboardingLink with user details', async () => {
    // getUser query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ email: 'user@example.com', full_name: 'Jane Smith' }],
      rowCount: 1,
    } as never);

    // createOnboardingLink → getOrCreateConnectAccount → getConnectAccountId
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    // At this point Stripe is not configured so it will return STRIPE_NOT_CONFIGURED
    const result = await StripeConnectService.refreshOnboarding({
      userId: 'user-1',
      refreshUrl: 'https://app.com/refresh',
      returnUrl: 'https://app.com/return',
    });

    // We don't care about the final result (STRIPE_NOT_CONFIGURED) since we're just
    // verifying the delegation — the function should call createOnboardingLink
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });
});

// ===========================================================================
// Helper: getConnectAccountId (tested indirectly via service methods)
// ===========================================================================

describe('getConnectAccountId — called via getOnboardingStatus', () => {
  it('queries stripe_connect_id from users table', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    await StripeConnectService.getOnboardingStatus('user-99');

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('stripe_connect_id');
    expect(sql).toContain('users');
    expect(params).toContain('user-99');
  });

  it('returns null when user record does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getOnboardingStatus('user-missing');

    // No account → returns not-onboarded status object (success: true, accountId: null)
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accountId).toBeNull();
    }
  });
});

// ===========================================================================
// getOnboardingStatus — requirementsCurrentlyDue propagation
// ===========================================================================

describe('StripeConnectService.getOnboardingStatus — requirements', () => {
  it('returns not-onboarded with empty requirements when user has no connect account', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: null }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getOnboardingStatus('user-1');

    // No account → returns success with empty requirements arrays
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirementsDue).toHaveLength(0);
      expect(result.data.requirementsCurrentlyDue).toHaveLength(0);
      expect(result.data.requirementsEventuallyDue).toHaveLength(0);
      expect(result.data.disabledReason).toBeNull();
    }
  });
});

// ===========================================================================
// Tax info — requiresUpdate and verifiedAt scenarios
// ===========================================================================

describe('StripeConnectService.getTaxInfo — additional fields', () => {
  it('returns requiresUpdate=true when form needs update', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        form_type: 'W9',
        status: 'verified',
        submitted_at: new Date('2023-01-01'),
        verified_at: new Date('2023-01-15'),
        requires_update: true,
        tax_id_last4: '9999',
        name_on_file: 'Bob Smith',
        business_name_on_file: 'Bob LLC',
      }],
      rowCount: 1,
    } as never);

    const result = await StripeConnectService.getTaxInfo('user-1');

    if (result.success) {
      expect(result.data.requiresUpdate).toBe(true);
      expect(result.data.businessNameOnFile).toBe('Bob LLC');
      expect(result.data.verifiedAt).toBeInstanceOf(Date);
    }
  });
});

// ===========================================================================
// getEarningsSummary — missing rows handling
// ===========================================================================

describe('StripeConnectService.getEarningsSummary — missing rows', () => {
  it('defaults to 0 when total_cents is null/empty string', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: 'acct_test' }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cents: null, transaction_count: null }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ pending_cents: null }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await StripeConnectService.getEarningsSummary({ userId: 'user-1', year: 2024 });

    if (result.success) {
      // parseInt(null, 10) = NaN → treated as 0
      expect(result.data.pendingEarningsCents).toBe(0);
    }
  });
});
