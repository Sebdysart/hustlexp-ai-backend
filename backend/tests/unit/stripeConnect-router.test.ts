/**
 * Stripe Connect Router Unit Tests
 *
 * Tests all 10 procedures in the stripeConnect router:
 *   - getOnboardingStatus (query)
 *   - createOnboardingLink (mutation)
 *   - getDashboardLink (query)
 *   - getPayoutSettings (query)
 *   - updatePayoutSettings (mutation)
 *   - getTaxInfo (query)
 *   - submitTaxInfo (mutation)
 *   - getEarningsSummary (query)
 *   - get1099Status (query)
 *   - getAccountDetails (query)
 *   - refreshOnboarding (mutation)
 *
 * Pattern: mock both service modules (StripeConnectService, TaxReportingService)
 * at module level, use createCaller with a fake user context, then assert
 * return shapes and error mappings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before imports that transitively touch these modules
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_placeholder' },
  },
}));

// Set ALLOWED_ORIGINS so isAllowedRedirectUrl accepts the test URLs used below.
process.env.ALLOWED_ORIGINS = 'https://hustlexp.com,https://example.com';

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    execute: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
}));

// Mock StripeConnectService as a module-level mock
const mockGetOnboardingStatus = vi.fn();
const mockCreateOnboardingLink = vi.fn();
const mockGetDashboardLink = vi.fn();
const mockGetPayoutSettings = vi.fn();
const mockUpdatePayoutSettings = vi.fn();
const mockGetTaxInfo = vi.fn();
const mockSubmitTaxInfo = vi.fn();
const mockGetEarningsSummary = vi.fn();
const mockGetAccountDetails = vi.fn();
const mockRefreshOnboarding = vi.fn();

vi.mock('../../src/services/StripeConnectService', () => ({
  StripeConnectService: {
    getOnboardingStatus: (...args: unknown[]) => mockGetOnboardingStatus(...args),
    createOnboardingLink: (...args: unknown[]) => mockCreateOnboardingLink(...args),
    getDashboardLink: (...args: unknown[]) => mockGetDashboardLink(...args),
    getPayoutSettings: (...args: unknown[]) => mockGetPayoutSettings(...args),
    updatePayoutSettings: (...args: unknown[]) => mockUpdatePayoutSettings(...args),
    getTaxInfo: (...args: unknown[]) => mockGetTaxInfo(...args),
    submitTaxInfo: (...args: unknown[]) => mockSubmitTaxInfo(...args),
    getEarningsSummary: (...args: unknown[]) => mockGetEarningsSummary(...args),
    getAccountDetails: (...args: unknown[]) => mockGetAccountDetails(...args),
    refreshOnboarding: (...args: unknown[]) => mockRefreshOnboarding(...args),
    isConfigured: () => true,
  },
}));

// Mock TaxReportingService
const mockGet1099Status = vi.fn();

vi.mock('../../src/services/TaxReportingService', () => ({
  TaxReportingService: {
    get1099Status: (...args: unknown[]) => mockGet1099Status(...args),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after all vi.mock calls)
// ---------------------------------------------------------------------------

import { stripeConnectRouter } from '../../src/routers/stripeConnect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller() {
  const fakeUser = {
    id: 'user-abc-123',
    email: 'worker@hustlexp.com',
    full_name: 'Test Worker',
    role: 'worker',
    default_mode: 'worker', // hustlerProcedure requires default_mode === 'worker'
    firebase_uid: 'fb-worker-123',
  };
  return stripeConnectRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-worker-123',
  });
}

function makeUnauthenticatedCaller() {
  return stripeConnectRouter.createCaller({
    user: null,
    firebaseUid: null,
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripeConnect router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // getOnboardingStatus
  // =========================================================================
  describe('getOnboardingStatus', () => {
    it('returns onboarding status data on success', async () => {
      const mockData = {
        isOnboarded: true,
        accountId: 'acct_test123',
        accountStatus: 'enabled' as const,
        requirementsDue: [],
        requirementsCurrentlyDue: [],
        requirementsEventuallyDue: [],
        disabledReason: null,
        chargesEnabled: true,
        payoutsEnabled: true,
        onboardingUrl: null,
      };
      mockGetOnboardingStatus.mockResolvedValue({ success: true, data: mockData });

      const caller = makeCaller();
      const result = await caller.getOnboardingStatus();

      expect(result).toEqual(mockData);
      expect(mockGetOnboardingStatus).toHaveBeenCalledWith('user-abc-123');
    });

    it('returns not-onboarded status when no Stripe account', async () => {
      const mockData = {
        isOnboarded: false,
        accountId: null,
        accountStatus: null,
        requirementsDue: [],
        requirementsCurrentlyDue: [],
        requirementsEventuallyDue: [],
        disabledReason: null,
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingUrl: null,
      };
      mockGetOnboardingStatus.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().getOnboardingStatus();

      expect(result.isOnboarded).toBe(false);
      expect(result.accountId).toBeNull();
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockGetOnboardingStatus.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'Stripe API failure' },
      });

      await expect(makeCaller().getOnboardingStatus()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects unauthenticated calls', async () => {
      await expect(makeUnauthenticatedCaller().getOnboardingStatus()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  // =========================================================================
  // createOnboardingLink
  // =========================================================================
  describe('createOnboardingLink', () => {
    const validInput = {
      refreshUrl: 'https://hustlexp.com/refresh',
      returnUrl: 'https://hustlexp.com/return',
      collectTaxInfo: true,
    };

    it('returns onboarding link data on success', async () => {
      const mockData = {
        url: 'https://connect.stripe.com/setup/e/test123',
        expiresAt: new Date('2026-01-01T12:00:00Z'),
      };
      mockCreateOnboardingLink.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().createOnboardingLink(validInput);

      expect(result).toEqual(mockData);
      expect(result.url).toContain('stripe.com');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('passes correct params to service including user context', async () => {
      mockCreateOnboardingLink.mockResolvedValue({
        success: true,
        data: { url: 'https://stripe.com/link', expiresAt: new Date() },
      });

      await makeCaller().createOnboardingLink(validInput);

      expect(mockCreateOnboardingLink).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          refreshUrl: 'https://hustlexp.com/refresh',
          returnUrl: 'https://hustlexp.com/return',
          collectTaxInfo: true,
        })
      );
    });

    it('defaults collectTaxInfo to true when omitted', async () => {
      mockCreateOnboardingLink.mockResolvedValue({
        success: true,
        data: { url: 'https://stripe.com/link', expiresAt: new Date() },
      });

      await makeCaller().createOnboardingLink({
        refreshUrl: 'https://hustlexp.com/refresh',
        returnUrl: 'https://hustlexp.com/return',
      });

      expect(mockCreateOnboardingLink).toHaveBeenCalledWith(
        expect.objectContaining({ collectTaxInfo: true })
      );
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockCreateOnboardingLink.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'Failed to create account link' },
      });

      await expect(makeCaller().createOnboardingLink(validInput)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects invalid URL in refreshUrl', async () => {
      await expect(
        makeCaller().createOnboardingLink({
          refreshUrl: 'not-a-url',
          returnUrl: 'https://hustlexp.com/return',
        })
      ).rejects.toThrow();
    });

    it('rejects invalid URL in returnUrl', async () => {
      await expect(
        makeCaller().createOnboardingLink({
          refreshUrl: 'https://hustlexp.com/refresh',
          returnUrl: 'not-a-url',
        })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().createOnboardingLink(validInput)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // getDashboardLink
  // =========================================================================
  describe('getDashboardLink', () => {
    it('returns dashboard link data on success', async () => {
      const mockData = {
        url: 'https://connect.stripe.com/express/test123',
        expiresAt: new Date('2026-01-01T13:00:00Z'),
      };
      mockGetDashboardLink.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().getDashboardLink();

      expect(result).toEqual(mockData);
      expect(result.url).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('passes user id to service', async () => {
      mockGetDashboardLink.mockResolvedValue({
        success: true,
        data: { url: 'https://stripe.com/dash', expiresAt: new Date() },
      });

      await makeCaller().getDashboardLink();

      expect(mockGetDashboardLink).toHaveBeenCalledWith('user-abc-123');
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockGetDashboardLink.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      });

      await expect(makeCaller().getDashboardLink()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic service errors', async () => {
      mockGetDashboardLink.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'Unknown Stripe error' },
      });

      await expect(makeCaller().getDashboardLink()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects unauthenticated calls', async () => {
      await expect(makeUnauthenticatedCaller().getDashboardLink()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  // =========================================================================
  // getPayoutSettings
  // =========================================================================
  describe('getPayoutSettings', () => {
    const mockPayoutData = {
      schedule: 'standard' as const,
      instantEligible: true,
      instantFees: { percentage: 1.5, fixedCents: 0 },
      standardSchedule: {
        interval: 'daily' as const,
        weeklyAnchor: undefined,
        monthlyAnchor: undefined,
      },
      defaultBankAccount: null,
      defaultDebitCard: null,
    };

    it('returns payout settings on success', async () => {
      mockGetPayoutSettings.mockResolvedValue({ success: true, data: mockPayoutData });

      const result = await makeCaller().getPayoutSettings();

      expect(result).toEqual(mockPayoutData);
      expect(result.schedule).toBe('standard');
      expect(result.instantEligible).toBe(true);
      expect(result.standardSchedule.interval).toBe('daily');
    });

    it('returns instant fees when eligible', async () => {
      mockGetPayoutSettings.mockResolvedValue({ success: true, data: mockPayoutData });

      const result = await makeCaller().getPayoutSettings();

      expect(result.instantFees).toEqual({ percentage: 1.5, fixedCents: 0 });
    });

    it('returns null instant fees when not eligible', async () => {
      mockGetPayoutSettings.mockResolvedValue({
        success: true,
        data: { ...mockPayoutData, instantEligible: false, instantFees: null },
      });

      const result = await makeCaller().getPayoutSettings();

      expect(result.instantEligible).toBe(false);
      expect(result.instantFees).toBeNull();
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockGetPayoutSettings.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(makeCaller().getPayoutSettings()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockGetPayoutSettings.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'API timeout' },
      });

      await expect(makeCaller().getPayoutSettings()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects unauthenticated calls', async () => {
      await expect(makeUnauthenticatedCaller().getPayoutSettings()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  // =========================================================================
  // updatePayoutSettings
  // =========================================================================
  describe('updatePayoutSettings', () => {
    const updatedPayoutData = {
      schedule: 'standard' as const,
      instantEligible: true,
      instantFees: { percentage: 1.5, fixedCents: 0 },
      standardSchedule: {
        interval: 'weekly' as const,
        weeklyAnchor: 'monday',
        monthlyAnchor: undefined,
      },
      defaultBankAccount: null,
      defaultDebitCard: null,
    };

    it('updates to standard schedule successfully', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({ success: true, data: updatedPayoutData });

      const result = await makeCaller().updatePayoutSettings({
        schedule: 'standard',
        interval: 'weekly',
        weeklyAnchor: 'monday',
      });

      expect(result.schedule).toBe('standard');
      expect(result.standardSchedule.interval).toBe('weekly');
    });

    it('passes all params including optional fields to service', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({ success: true, data: updatedPayoutData });

      await makeCaller().updatePayoutSettings({
        schedule: 'standard',
        interval: 'monthly',
        monthlyAnchor: 15,
        bankAccountId: 'ba_test123',
      });

      expect(mockUpdatePayoutSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          schedule: 'standard',
          interval: 'monthly',
          monthlyAnchor: 15,
          bankAccountId: 'ba_test123',
        })
      );
    });

    it('accepts instant schedule with debit card', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({
        success: true,
        data: { ...updatedPayoutData, schedule: 'instant' as const },
      });

      const result = await makeCaller().updatePayoutSettings({
        schedule: 'instant',
        debitCardId: 'card_test456',
      });

      expect(result.schedule).toBe('instant');
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'standard' })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('throws PRECONDITION_FAILED when instant payout not eligible', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({
        success: false,
        error: { code: 'INSTANT_PAYOUT_NOT_ELIGIBLE', message: 'not eligible' },
      });

      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'instant' })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Instant payout is not available for your account',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockUpdatePayoutSettings.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'update failed' },
      });

      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'standard' })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });

    it('rejects invalid schedule value', async () => {
      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'invalid' as any })
      ).rejects.toThrow();
    });

    it('rejects invalid interval value', async () => {
      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'standard', interval: 'biweekly' as any })
      ).rejects.toThrow();
    });

    it('rejects monthlyAnchor out of range (0)', async () => {
      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'standard', monthlyAnchor: 0 })
      ).rejects.toThrow();
    });

    it('rejects monthlyAnchor out of range (32)', async () => {
      await expect(
        makeCaller().updatePayoutSettings({ schedule: 'standard', monthlyAnchor: 32 })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().updatePayoutSettings({ schedule: 'standard' })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // getTaxInfo
  // =========================================================================
  describe('getTaxInfo', () => {
    it('returns tax info when form exists', async () => {
      const mockData = {
        formType: 'W9' as const,
        status: 'verified' as const,
        submittedAt: new Date('2025-03-01T00:00:00Z'),
        verifiedAt: new Date('2025-03-02T00:00:00Z'),
        requiresUpdate: false,
        taxIdLast4: '1234',
        nameOnFile: 'Test Worker',
        businessNameOnFile: null,
      };
      mockGetTaxInfo.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().getTaxInfo();

      expect(result).toEqual(mockData);
      expect(result.formType).toBe('W9');
      expect(result.status).toBe('verified');
      expect(result.taxIdLast4).toBe('1234');
    });

    it('returns not_submitted status when no form exists', async () => {
      const mockData = {
        formType: null,
        status: 'not_submitted' as const,
        submittedAt: null,
        verifiedAt: null,
        requiresUpdate: false,
        taxIdLast4: null,
        nameOnFile: null,
        businessNameOnFile: null,
      };
      mockGetTaxInfo.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().getTaxInfo();

      expect(result.formType).toBeNull();
      expect(result.status).toBe('not_submitted');
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockGetTaxInfo.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(makeCaller().getTaxInfo()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockGetTaxInfo.mockResolvedValue({
        success: false,
        error: { code: 'DATABASE_ERROR', message: 'query failed' },
      });

      await expect(makeCaller().getTaxInfo()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects unauthenticated calls', async () => {
      await expect(makeUnauthenticatedCaller().getTaxInfo()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  // =========================================================================
  // submitTaxInfo
  // =========================================================================
  describe('submitTaxInfo', () => {
    const validW9Input = {
      formType: 'W9' as const,
      name: 'Test Worker',
      taxClassification: 'INDIVIDUAL' as const,
      addressLine1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      zipCode: '73301',
      country: 'US',
      ssnLast4: '1234',
      signature: 'Test Worker',
      signatureDate: '2025-03-01T00:00:00Z',
    };

    it('submits W-9 form successfully', async () => {
      const mockData = {
        formType: 'W9' as const,
        status: 'pending' as const,
        submittedAt: new Date(),
        verifiedAt: null,
        requiresUpdate: false,
        taxIdLast4: '1234',
        nameOnFile: 'Test Worker',
        businessNameOnFile: null,
      };
      mockSubmitTaxInfo.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().submitTaxInfo(validW9Input);

      expect(result.formType).toBe('W9');
      expect(result.status).toBe('pending');
      expect(result.taxIdLast4).toBe('1234');
    });

    it('passes userId and form data to service', async () => {
      mockSubmitTaxInfo.mockResolvedValue({
        success: true,
        data: {
          formType: 'W9', status: 'pending', submittedAt: new Date(),
          verifiedAt: null, requiresUpdate: false, taxIdLast4: '1234',
          nameOnFile: 'Test Worker', businessNameOnFile: null,
        },
      });

      await makeCaller().submitTaxInfo(validW9Input);

      expect(mockSubmitTaxInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          formType: 'W9',
          name: 'Test Worker',
          ssnLast4: '1234',
        })
      );
    });

    it('submits W-8BEN form for non-US persons', async () => {
      const w8benInput = {
        formType: 'W8BEN' as const,
        name: 'Foreign Worker',
        country: 'GB',
        foreignTaxId: 'UK123456789',
        treatyCountry: 'GB',
        treatyArticle: 'Article 14',
      };

      mockSubmitTaxInfo.mockResolvedValue({
        success: true,
        data: {
          formType: 'W8BEN', status: 'pending', submittedAt: new Date(),
          verifiedAt: null, requiresUpdate: false, taxIdLast4: null,
          nameOnFile: 'Foreign Worker', businessNameOnFile: null,
        },
      });

      const result = await makeCaller().submitTaxInfo(w8benInput);

      expect(result.formType).toBe('W8BEN');
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockSubmitTaxInfo.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(makeCaller().submitTaxInfo(validW9Input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws BAD_REQUEST when tax info is invalid', async () => {
      mockSubmitTaxInfo.mockResolvedValue({
        success: false,
        error: { code: 'TAX_INFO_INVALID', message: 'SSN format incorrect' },
      });

      await expect(makeCaller().submitTaxInfo(validW9Input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'SSN format incorrect',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockSubmitTaxInfo.mockResolvedValue({
        success: false,
        error: { code: 'DATABASE_ERROR', message: 'insert failed' },
      });

      await expect(makeCaller().submitTaxInfo(validW9Input)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects invalid formType', async () => {
      await expect(
        makeCaller().submitTaxInfo({ ...validW9Input, formType: 'W2' as any })
      ).rejects.toThrow();
    });

    it('rejects ssnLast4 with wrong format (letters)', async () => {
      await expect(
        makeCaller().submitTaxInfo({ ...validW9Input, ssnLast4: 'abcd' })
      ).rejects.toThrow();
    });

    it('rejects ssnLast4 with wrong length', async () => {
      await expect(
        makeCaller().submitTaxInfo({ ...validW9Input, ssnLast4: '123' })
      ).rejects.toThrow();
    });

    it('rejects EIN with wrong format', async () => {
      await expect(
        makeCaller().submitTaxInfo({ ...validW9Input, ein: '12345' })
      ).rejects.toThrow();
    });

    it('accepts valid 9-digit EIN', async () => {
      mockSubmitTaxInfo.mockResolvedValue({
        success: true,
        data: {
          formType: 'W9', status: 'pending', submittedAt: new Date(),
          verifiedAt: null, requiresUpdate: false, taxIdLast4: '6789',
          nameOnFile: 'Test Worker', businessNameOnFile: null,
        },
      });

      const result = await makeCaller().submitTaxInfo({
        ...validW9Input,
        ssnLast4: undefined,
        ein: '123456789',
      });

      expect(result.status).toBe('pending');
    });

    it('rejects country code with wrong length', async () => {
      await expect(
        makeCaller().submitTaxInfo({ ...validW9Input, country: 'USA' })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().submitTaxInfo(validW9Input)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // getEarningsSummary
  // =========================================================================
  describe('getEarningsSummary', () => {
    const mockEarningsData = {
      year: 2026,
      totalEarningsCents: 1500000,
      totalTransactions: 45,
      threshold1099K: {
        amount: 500000,
        transactions: 200,
        metAmountThreshold: true,
        metTransactionThreshold: false,
        willReceive1099K: true,
      },
      byMonth: [
        { month: 1, earningsCents: 500000, transactions: 15 },
        { month: 2, earningsCents: 600000, transactions: 18 },
        { month: 3, earningsCents: 400000, transactions: 12 },
      ],
      pendingEarningsCents: 50000,
      availableBalanceCents: 0,
    };

    it('returns earnings summary for current year by default', async () => {
      mockGetEarningsSummary.mockResolvedValue({ success: true, data: mockEarningsData });

      const result = await makeCaller().getEarningsSummary();

      expect(result.year).toBe(2026);
      expect(result.totalEarningsCents).toBe(1500000);
      expect(result.totalTransactions).toBe(45);
      expect(result.byMonth).toHaveLength(3);
    });

    it('returns 1099-K threshold status', async () => {
      mockGetEarningsSummary.mockResolvedValue({ success: true, data: mockEarningsData });

      const result = await makeCaller().getEarningsSummary();

      expect(result.threshold1099K).toBeDefined();
      expect(result.threshold1099K.metAmountThreshold).toBe(true);
      expect(result.threshold1099K.metTransactionThreshold).toBe(false);
      expect(result.threshold1099K.willReceive1099K).toBe(true);
    });

    it('accepts a specific year parameter', async () => {
      mockGetEarningsSummary.mockResolvedValue({
        success: true,
        data: { ...mockEarningsData, year: 2025 },
      });

      await makeCaller().getEarningsSummary({ year: 2025 });

      expect(mockGetEarningsSummary).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-abc-123', year: 2025 })
      );
    });

    it('passes current year when input is omitted', async () => {
      mockGetEarningsSummary.mockResolvedValue({ success: true, data: mockEarningsData });

      await makeCaller().getEarningsSummary();

      expect(mockGetEarningsSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          year: new Date().getFullYear(),
        })
      );
    });

    it('returns empty byMonth array for no earnings', async () => {
      mockGetEarningsSummary.mockResolvedValue({
        success: true,
        data: {
          ...mockEarningsData,
          totalEarningsCents: 0,
          totalTransactions: 0,
          byMonth: [],
          threshold1099K: {
            ...mockEarningsData.threshold1099K,
            metAmountThreshold: false,
            willReceive1099K: false,
          },
        },
      });

      const result = await makeCaller().getEarningsSummary();

      expect(result.totalEarningsCents).toBe(0);
      expect(result.byMonth).toHaveLength(0);
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockGetEarningsSummary.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(makeCaller().getEarningsSummary()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockGetEarningsSummary.mockResolvedValue({
        success: false,
        error: { code: 'DATABASE_ERROR', message: 'query timeout' },
      });

      await expect(makeCaller().getEarningsSummary()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects year below 2020', async () => {
      await expect(
        makeCaller().getEarningsSummary({ year: 2019 })
      ).rejects.toThrow();
    });

    it('rejects year above 2100', async () => {
      await expect(
        makeCaller().getEarningsSummary({ year: 2101 })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().getEarningsSummary()
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // get1099Status
  // =========================================================================
  describe('get1099Status', () => {
    it('returns tax filing records on success', async () => {
      const mockData = [
        {
          id: 'filing-1',
          user_id: 'user-abc-123',
          tax_year: 2025,
          form_type: '1099_nec',
          total_earnings_cents: 250000,
          stripe_tax_form_id: 'txf_test123',
          status: 'generated',
          filed_at: null,
          created_at: new Date('2026-01-15T00:00:00Z'),
        },
      ];
      mockGet1099Status.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().get1099Status();

      expect(result).toEqual(mockData);
      expect(result).toHaveLength(1);
      expect(result[0].tax_year).toBe(2025);
    });

    it('returns empty array when no filings exist', async () => {
      mockGet1099Status.mockResolvedValue({ success: true, data: [] });

      const result = await makeCaller().get1099Status();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('passes user id and optional tax year to service', async () => {
      mockGet1099Status.mockResolvedValue({ success: true, data: [] });

      await makeCaller().get1099Status({ taxYear: 2025 });

      expect(mockGet1099Status).toHaveBeenCalledWith('user-abc-123', 2025);
    });

    it('passes undefined taxYear when not provided', async () => {
      mockGet1099Status.mockResolvedValue({ success: true, data: [] });

      await makeCaller().get1099Status();

      expect(mockGet1099Status).toHaveBeenCalledWith('user-abc-123', undefined);
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockGet1099Status.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'database connection lost' },
      });

      await expect(makeCaller().get1099Status()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects taxYear below 2020', async () => {
      await expect(
        makeCaller().get1099Status({ taxYear: 2019 })
      ).rejects.toThrow();
    });

    it('rejects taxYear above 2100', async () => {
      await expect(
        makeCaller().get1099Status({ taxYear: 2101 })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().get1099Status()
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // getAccountDetails
  // =========================================================================
  describe('getAccountDetails', () => {
    const mockAccountData = {
      accountId: 'acct_test123',
      accountType: 'express' as const,
      email: 'worker@hustlexp.com',
      country: 'US',
      defaultCurrency: 'usd',
      status: {
        onboardingComplete: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: false,
      },
      capabilities: {
        cardPayments: 'active' as const,
        transfers: 'active' as const,
      },
      requirements: {
        currentlyDue: [],
        eventuallyDue: [],
        pastDue: [],
        disabledReason: null,
      },
      settings: {
        payoutSchedule: 'daily',
        debitCardPayoutsEnabled: false,
      },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };

    it('returns full account details on success', async () => {
      mockGetAccountDetails.mockResolvedValue({ success: true, data: mockAccountData });

      const result = await makeCaller().getAccountDetails();

      expect(result).toEqual(mockAccountData);
      expect(result.accountId).toBe('acct_test123');
      expect(result.accountType).toBe('express');
      expect(result.status.onboardingComplete).toBe(true);
    });

    it('returns capabilities status', async () => {
      mockGetAccountDetails.mockResolvedValue({ success: true, data: mockAccountData });

      const result = await makeCaller().getAccountDetails();

      expect(result.capabilities.cardPayments).toBe('active');
      expect(result.capabilities.transfers).toBe('active');
    });

    it('returns pending requirements when they exist', async () => {
      const dataWithRequirements = {
        ...mockAccountData,
        status: { ...mockAccountData.status, requirementsDue: true },
        requirements: {
          currentlyDue: ['individual.verification.document'],
          eventuallyDue: ['individual.ssn_last_4'],
          pastDue: [],
          disabledReason: null,
        },
      };
      mockGetAccountDetails.mockResolvedValue({ success: true, data: dataWithRequirements });

      const result = await makeCaller().getAccountDetails();

      expect(result.status.requirementsDue).toBe(true);
      expect(result.requirements.currentlyDue).toContain('individual.verification.document');
      expect(result.requirements.eventuallyDue).toContain('individual.ssn_last_4');
    });

    it('passes user id to service', async () => {
      mockGetAccountDetails.mockResolvedValue({ success: true, data: mockAccountData });

      await makeCaller().getAccountDetails();

      expect(mockGetAccountDetails).toHaveBeenCalledWith('user-abc-123');
    });

    it('throws PRECONDITION_FAILED when Stripe not setup', async () => {
      mockGetAccountDetails.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'not setup' },
      });

      await expect(makeCaller().getAccountDetails()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
      mockGetAccountDetails.mockResolvedValue({
        success: false,
        error: { code: 'STRIPE_ERROR', message: 'Account retrieval failed' },
      });

      await expect(makeCaller().getAccountDetails()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().getAccountDetails()
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // refreshOnboarding
  // =========================================================================
  describe('refreshOnboarding', () => {
    const validInput = {
      refreshUrl: 'https://hustlexp.com/refresh',
      returnUrl: 'https://hustlexp.com/return',
    };

    it('returns a new onboarding link on success', async () => {
      const mockData = {
        url: 'https://connect.stripe.com/setup/e/refreshed123',
        expiresAt: new Date('2026-01-01T14:00:00Z'),
      };
      mockRefreshOnboarding.mockResolvedValue({ success: true, data: mockData });

      const result = await makeCaller().refreshOnboarding(validInput);

      expect(result).toEqual(mockData);
      expect(result.url).toContain('stripe.com');
    });

    it('passes userId and URLs to service', async () => {
      mockRefreshOnboarding.mockResolvedValue({
        success: true,
        data: { url: 'https://stripe.com/link', expiresAt: new Date() },
      });

      await makeCaller().refreshOnboarding(validInput);

      expect(mockRefreshOnboarding).toHaveBeenCalledWith({
        userId: 'user-abc-123',
        refreshUrl: 'https://hustlexp.com/refresh',
        returnUrl: 'https://hustlexp.com/return',
      });
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockRefreshOnboarding.mockResolvedValue({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });

      await expect(makeCaller().refreshOnboarding(validInput)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('rejects invalid refreshUrl', async () => {
      await expect(
        makeCaller().refreshOnboarding({
          refreshUrl: 'not-a-url',
          returnUrl: 'https://hustlexp.com/return',
        })
      ).rejects.toThrow();
    });

    it('rejects invalid returnUrl', async () => {
      await expect(
        makeCaller().refreshOnboarding({
          refreshUrl: 'https://hustlexp.com/refresh',
          returnUrl: 'invalid',
        })
      ).rejects.toThrow();
    });

    it('rejects unauthenticated calls', async () => {
      await expect(
        makeUnauthenticatedCaller().refreshOnboarding(validInput)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // =========================================================================
  // Cross-cutting: authentication enforcement
  // =========================================================================
  describe('authentication enforcement (all procedures)', () => {
    it('all query procedures reject unauthenticated calls', async () => {
      const unauthCaller = makeUnauthenticatedCaller();

      const queryProcedures = [
        () => unauthCaller.getOnboardingStatus(),
        () => unauthCaller.getDashboardLink(),
        () => unauthCaller.getPayoutSettings(),
        () => unauthCaller.getTaxInfo(),
        () => unauthCaller.getEarningsSummary(),
        () => unauthCaller.get1099Status(),
        () => unauthCaller.getAccountDetails(),
      ];

      for (const proc of queryProcedures) {
        await expect(proc()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    });

    it('all mutation procedures reject unauthenticated calls', async () => {
      const unauthCaller = makeUnauthenticatedCaller();

      const mutationProcedures = [
        () => unauthCaller.createOnboardingLink({
          refreshUrl: 'https://example.com/r',
          returnUrl: 'https://example.com/ret',
        }),
        () => unauthCaller.updatePayoutSettings({ schedule: 'standard' }),
        () => unauthCaller.submitTaxInfo({ formType: 'W9' }),
        () => unauthCaller.refreshOnboarding({
          refreshUrl: 'https://example.com/r',
          returnUrl: 'https://example.com/ret',
        }),
      ];

      for (const proc of mutationProcedures) {
        await expect(proc()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    });
  });
});
