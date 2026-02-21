/**
 * Stripe Connect Service v1.0.0
 * 
 * CONSTITUTIONAL: Worker Stripe Connect account management
 * 
 * Handles:
 * - Stripe Express account creation and onboarding
 * - Payout settings management
 * - Tax information collection
 * - Earnings tracking for 1099 reporting
 * 
 * @see PRODUCT_SPEC.md §4 (Payments)
 */

import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../db';
import type { ServiceResult } from '../types';
import { stripeBreaker } from '../middleware/circuit-breaker';
import { stripeLogger } from '../logger';

// ============================================================================
// INITIALIZATION
// ============================================================================

let stripe: Stripe | null = null;

if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2025-12-15.clover',
  });
  stripeLogger.info('Stripe Connect initialized');
} else {
  stripeLogger.warn('Stripe Connect not configured (placeholder or missing key)');
}

// ============================================================================
// TYPES
// ============================================================================

export interface OnboardingStatus {
  isOnboarded: boolean;
  accountId: string | null;
  accountStatus: 'pending' | 'enabled' | 'restricted' | 'disabled' | null;
  requirementsDue: string[];
  requirementsCurrentlyDue: string[];
  requirementsEventuallyDue: string[];
  disabledReason: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingUrl: string | null;
}

export interface OnboardingLinkResult {
  url: string;
  expiresAt: Date;
}

export interface DashboardLinkResult {
  url: string;
  expiresAt: Date;
}

export interface PayoutSettings {
  schedule: 'instant' | 'standard';
  instantEligible: boolean;
  instantFees: {
    percentage: number;
    fixedCents: number;
  } | null;
  standardSchedule: {
    interval: 'daily' | 'weekly' | 'monthly' | 'manual';
    weeklyAnchor?: string;
    monthlyAnchor?: number;
  };
  defaultBankAccount: {
    id: string;
    last4: string;
    bankName: string;
  } | null;
  defaultDebitCard: {
    id: string;
    last4: string;
    brand: string;
  } | null;
}

export interface TaxInfo {
  formType: 'W9' | 'W8BEN' | 'W8BENE' | null;
  status: 'not_submitted' | 'pending' | 'verified' | 'rejected';
  submittedAt: Date | null;
  verifiedAt: Date | null;
  requiresUpdate: boolean;
  taxIdLast4: string | null;
  nameOnFile: string | null;
  businessNameOnFile: string | null;
}

export interface TaxInfoInput {
  formType: 'W9' | 'W8BEN' | 'W8BENE';
  name?: string;
  businessName?: string;
  taxClassification?: string;
  llcClassification?: 'C' | 'S' | 'P';
  otherClassification?: string;
  exemptions?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  ssnLast4?: string;
  ein?: string;
  foreignTaxId?: string;
  treatyCountry?: string;
  treatyArticle?: string;
  signature?: string;
  signatureDate?: string;
}

export interface EarningsSummary {
  year: number;
  totalEarningsCents: number;
  totalTransactions: number;
  threshold1099K: {
    amount: number;
    transactions: number;
    metAmountThreshold: boolean;
    metTransactionThreshold: boolean;
    willReceive1099K: boolean;
  };
  byMonth: {
    month: number;
    earningsCents: number;
    transactions: number;
  }[];
  pendingEarningsCents: number;
  availableBalanceCents: number;
}

export interface AccountDetails {
  accountId: string;
  accountType: 'express';
  email: string;
  country: string;
  defaultCurrency: string;
  status: {
    onboardingComplete: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: boolean;
  };
  capabilities: {
    cardPayments: 'active' | 'inactive' | 'pending';
    transfers: 'active' | 'inactive' | 'pending';
  };
  requirements: {
    currentlyDue: string[];
    eventuallyDue: string[];
    pastDue: string[];
    disabledReason: string | null;
  };
  settings: {
    payoutSchedule: string;
    debitCardPayoutsEnabled: boolean;
  };
  createdAt: Date;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get or create Stripe Connect account for user
 */
async function getOrCreateConnectAccount(
  userId: string,
  email: string,
  fullName: string
): Promise<ServiceResult<{ accountId: string; isNew: boolean }>> {
  // Check if user already has a connect account
  const userResult = await db.query<{ stripe_connect_id: string | null }>(
    'SELECT stripe_connect_id FROM users WHERE id = $1',
    [userId]
  );

  if (userResult.rows.length === 0) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  const existingAccountId = userResult.rows[0].stripe_connect_id;

  // If account exists, return it
  if (existingAccountId) {
    return {
      success: true,
      data: { accountId: existingAccountId, isNew: false },
    };
  }

  // Create new Stripe Connect Express account
  if (!stripe) {
    return {
      success: false,
      error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
    };
  }

  try {
    const account = await stripeBreaker.execute(() =>
      stripe!.accounts.create({
        type: 'express',
        email,
        business_type: 'individual',
        individual: {
          first_name: fullName.split(' ')[0],
          last_name: fullName.split(' ').slice(1).join(' ') || undefined,
        },
        metadata: {
          user_id: userId,
        },
      })
    );

    // Save account ID to user record
    await db.query(
      'UPDATE users SET stripe_connect_id = $1, updated_at = NOW() WHERE id = $2',
      [account.id, userId]
    );

    stripeLogger.info({ userId, accountId: account.id }, 'Created Stripe Connect account');

    return {
      success: true,
      data: { accountId: account.id, isNew: true },
    };
  } catch (error) {
    stripeLogger.error({ err: error, userId }, 'Failed to create Stripe Connect account');
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown Stripe error',
      },
    };
  }
}

/**
 * Get user's Stripe Connect account ID
 */
async function getConnectAccountId(userId: string): Promise<string | null> {
  const result = await db.query<{ stripe_connect_id: string | null }>(
    'SELECT stripe_connect_id FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0]?.stripe_connect_id || null;
}

// ============================================================================
// SERVICE
// ============================================================================

export const StripeConnectService = {
  /**
   * Check if Stripe is configured
   */
  isConfigured: (): boolean => stripe !== null,

  /**
   * Get onboarding status for a worker
   */
  getOnboardingStatus: async (userId: string): Promise<ServiceResult<OnboardingStatus>> => {
    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: true,
        data: {
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
        },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const account = await stripeBreaker.execute(() => stripe!.accounts.retrieve(accountId));

      const requirements = account.requirements || {};
      const isOnboarded = account.charges_enabled && account.payouts_enabled;

      return {
        success: true,
        data: {
          isOnboarded,
          accountId,
          accountStatus: account.capabilities?.transfers === 'active' ? 'enabled' : 'restricted',
          requirementsDue: requirements.currently_due || [],
          requirementsCurrentlyDue: requirements.currently_due || [],
          requirementsEventuallyDue: requirements.eventually_due || [],
          disabledReason: requirements.disabled_reason || null,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          onboardingUrl: !isOnboarded ? `/api/stripe-connect/onboard?userId=${userId}` : null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Create onboarding link for worker to complete KYC
   */
  createOnboardingLink: async (params: {
    userId: string;
    email: string;
    fullName: string;
    refreshUrl: string;
    returnUrl: string;
    collectTaxInfo?: boolean;
  }): Promise<ServiceResult<OnboardingLinkResult>> => {
    const { userId, email, fullName, refreshUrl, returnUrl, collectTaxInfo = true } = params;

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    // Get or create account
    const accountResult = await getOrCreateConnectAccount(userId, email, fullName);
    if (!accountResult.success) {
      return accountResult;
    }

    const { accountId } = accountResult.data;

    try {
      const accountLink = await stripeBreaker.execute(() =>
        stripe!.accountLinks.create({
          account: accountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: 'account_onboarding',
          collect: collectTaxInfo ? 'eventually_due' : undefined,
        })
      );

      return {
        success: true,
        data: {
          url: accountLink.url,
          expiresAt: new Date(accountLink.expires_at * 1000),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Get dashboard link to worker's Stripe Express dashboard
   */
  getDashboardLink: async (userId: string): Promise<ServiceResult<DashboardLinkResult>> => {
    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const loginLink = await stripeBreaker.execute(() =>
        stripe!.accounts.createLoginLink(accountId)
      );

      return {
        success: true,
        data: {
          url: loginLink.url,
          expiresAt: new Date(Date.now() + 3600 * 1000), // Links typically expire in 1 hour
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Get current payout settings
   */
  getPayoutSettings: async (userId: string): Promise<ServiceResult<PayoutSettings>> => {
    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const account = await stripeBreaker.execute(() => stripe!.accounts.retrieve(accountId));

      const settings = account.settings;
      const payoutSettings = settings?.payouts;
      const cardPayments = settings?.card_payments;

      // Determine if instant payouts are available
      const instantEligible = account.capabilities?.transfers === 'active' && 
                             cardPayments?.statement_descriptor !== undefined;

      return {
        success: true,
        data: {
          schedule: instantEligible ? 'standard' : 'standard', // Default to standard
          instantEligible,
          instantFees: instantEligible ? { percentage: 1.5, fixedCents: 0 } : null,
          standardSchedule: {
            interval: (payoutSettings?.schedule?.interval as any) || 'daily',
            weeklyAnchor: payoutSettings?.schedule?.weekly_anchor || undefined,
            monthlyAnchor: payoutSettings?.schedule?.monthly_anchor || undefined,
          },
          defaultBankAccount: null, // Would be fetched from external_accounts
          defaultDebitCard: null, // Would be fetched from external_accounts
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Update payout preferences
   */
  updatePayoutSettings: async (params: {
    userId: string;
    schedule: 'instant' | 'standard';
    debitCardId?: string;
    bankAccountId?: string;
    interval?: 'daily' | 'weekly' | 'monthly' | 'manual';
    weeklyAnchor?: string;
    monthlyAnchor?: number;
  }): Promise<ServiceResult<PayoutSettings>> => {
    const { userId, schedule, interval, weeklyAnchor, monthlyAnchor } = params;

    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      // Check instant payout eligibility if requested
      if (schedule === 'instant') {
        const account = await stripeBreaker.execute(() => stripe!.accounts.retrieve(accountId));
        const isEligible = account.capabilities?.transfers === 'active';
        
        if (!isEligible) {
          return {
            success: false,
            error: { code: 'INSTANT_PAYOUT_NOT_ELIGIBLE', message: 'Instant payout not eligible' },
          };
        }
      }

      // Update standard payout schedule if provided
      if (interval && schedule === 'standard') {
        await stripeBreaker.execute(() =>
          stripe!.accounts.update(accountId, {
            settings: {
              payouts: {
                schedule: {
                  interval: interval as any,
                  weekly_anchor: weeklyAnchor as any,
                  monthly_anchor: monthlyAnchor,
                },
              },
            },
          })
        );
      }

      // Return updated settings
      return StripeConnectService.getPayoutSettings(userId);
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Get tax information status
   */
  getTaxInfo: async (userId: string): Promise<ServiceResult<TaxInfo>> => {
    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    // In production, this would fetch from Stripe or a tax info table
    // For now, return placeholder
    return {
      success: true,
      data: {
        formType: null,
        status: 'not_submitted',
        submittedAt: null,
        verifiedAt: null,
        requiresUpdate: false,
        taxIdLast4: null,
        nameOnFile: null,
        businessNameOnFile: null,
      },
    };
  },

  /**
   * Submit tax information (W-9 or W-8BEN)
   */
  submitTaxInfo: async (params: TaxInfoInput & { userId: string }): Promise<ServiceResult<TaxInfo>> => {
    const { userId } = params;

    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    // In production, this would submit to Stripe's tax form API or store for manual processing
    // For now, return success with placeholder
    return {
      success: true,
      data: {
        formType: params.formType,
        status: 'pending',
        submittedAt: new Date(),
        verifiedAt: null,
        requiresUpdate: false,
        taxIdLast4: params.ssnLast4 || params.ein?.slice(-4) || null,
        nameOnFile: params.name || null,
        businessNameOnFile: params.businessName || null,
      },
    };
  },

  /**
   * Get earnings summary for 1099 threshold tracking
   */
  getEarningsSummary: async (params: { userId: string; year: number }): Promise<ServiceResult<EarningsSummary>> => {
    const { userId, year } = params;

    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    try {
      // Calculate earnings from completed tasks
      const earningsResult = await db.query<{
        total_cents: string;
        transaction_count: string;
      }>(
        `SELECT 
          COALESCE(SUM(e.amount), 0) as total_cents,
          COUNT(*) as transaction_count
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.worker_id = $1 
           AND e.state = 'RELEASED'
           AND EXTRACT(YEAR FROM e.released_at) = $2`,
        [userId, year]
      );

      const totalEarningsCents = parseInt(earningsResult.rows[0]?.total_cents || '0', 10);
      const totalTransactions = parseInt(earningsResult.rows[0]?.transaction_count || '0', 10);

      // Get pending earnings (funded but not released)
      const pendingResult = await db.query<{ pending_cents: string }>(
        `SELECT COALESCE(SUM(e.amount), 0) as pending_cents
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.worker_id = $1 
           AND e.state = 'FUNDED'`,
        [userId]
      );
      const pendingEarningsCents = parseInt(pendingResult.rows[0]?.pending_cents || '0', 10);

      // Calculate monthly breakdown
      const monthlyResult = await db.query<{
        month: number;
        earnings_cents: string;
        transactions: string;
      }>(
        `SELECT 
          EXTRACT(MONTH FROM e.released_at) as month,
          COALESCE(SUM(e.amount), 0) as earnings_cents,
          COUNT(*) as transactions
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.worker_id = $1 
           AND e.state = 'RELEASED'
           AND EXTRACT(YEAR FROM e.released_at) = $2
         GROUP BY EXTRACT(MONTH FROM e.released_at)
         ORDER BY month`,
        [userId, year]
      );

      const byMonth = monthlyResult.rows.map(row => ({
        month: row.month,
        earningsCents: parseInt(row.earnings_cents, 10),
        transactions: parseInt(row.transactions, 10),
      }));

      // 1099-K thresholds (IRS rules may change)
      const THRESHOLD_CENTS = 500000; // $5,000 (reduced threshold for 2024)
      const THRESHOLD_TRANSACTIONS = 200;

      return {
        success: true,
        data: {
          year,
          totalEarningsCents,
          totalTransactions,
          threshold1099K: {
            amount: THRESHOLD_CENTS,
            transactions: THRESHOLD_TRANSACTIONS,
            metAmountThreshold: totalEarningsCents >= THRESHOLD_CENTS,
            metTransactionThreshold: totalTransactions >= THRESHOLD_TRANSACTIONS,
            willReceive1099K: totalEarningsCents >= THRESHOLD_CENTS || totalTransactions >= THRESHOLD_TRANSACTIONS,
          },
          byMonth,
          pendingEarningsCents,
          availableBalanceCents: 0, // Would be fetched from Stripe
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown database error',
        },
      };
    }
  },

  /**
   * Get Stripe Connect account details
   */
  getAccountDetails: async (userId: string): Promise<ServiceResult<AccountDetails>> => {
    const accountId = await getConnectAccountId(userId);

    if (!accountId) {
      return {
        success: false,
        error: { code: 'STRIPE_CONNECT_NOT_SETUP', message: 'Stripe Connect account not set up' },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const account = await stripeBreaker.execute(() => stripe!.accounts.retrieve(accountId));
      const requirements = account.requirements || {};

      return {
        success: true,
        data: {
          accountId,
          accountType: 'express',
          email: account.email || '',
          country: account.country || 'US',
          defaultCurrency: account.default_currency || 'usd',
          status: {
            onboardingComplete: account.charges_enabled && account.payouts_enabled,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            requirementsDue: (requirements.currently_due?.length || 0) > 0,
          },
          capabilities: {
            cardPayments: (account.capabilities?.card_payments as any) || 'inactive',
            transfers: (account.capabilities?.transfers as any) || 'inactive',
          },
          requirements: {
            currentlyDue: requirements.currently_due || [],
            eventuallyDue: requirements.eventually_due || [],
            pastDue: requirements.past_due || [],
            disabledReason: requirements.disabled_reason || null,
          },
          settings: {
            payoutSchedule: account.settings?.payouts?.schedule?.interval || 'daily',
            debitCardPayoutsEnabled: false,
          },
          createdAt: new Date((account as any).created * 1000),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Refresh onboarding link
   */
  refreshOnboarding: async (params: {
    userId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<ServiceResult<OnboardingLinkResult>> => {
    // This is essentially the same as createOnboardingLink
    // Get user details first
    const userResult = await db.query<{ email: string; full_name: string }>(
      'SELECT email, full_name FROM users WHERE id = $1',
      [params.userId]
    );

    if (userResult.rows.length === 0) {
      return {
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      };
    }

    const user = userResult.rows[0];

    return StripeConnectService.createOnboardingLink({
      userId: params.userId,
      email: user.email,
      fullName: user.full_name,
      refreshUrl: params.refreshUrl,
      returnUrl: params.returnUrl,
    });
  },
};

export default StripeConnectService;
