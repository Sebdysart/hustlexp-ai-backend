/**
 * TAX COMPLIANCE SERVICE
 * 
 * Manages 1099-NEC/K tax reporting and KYC verification tracking.
 * Critical for IRS compliance - financial platforms must report payments.
 * 
 * Authority: Layer 1 (Backend Service)
 * Constitutional Reference: ARCHITECTURE.md §6, IRS Publication 1220
 * 
 * Regulations:
 * - 1099-NEC: Report non-employee compensation >= $600/year
 * - 1099-K: Report payment card transactions (200+ transactions OR $20,000+)
 * - W-9: Collect taxpayer identification before payments
 * 
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

const logger = createLogger('TaxComplianceService');

// ============================================================================
// CONSTANTS
// ============================================================================

// IRS Thresholds
const IRS_1099NEC_THRESHOLD_CENTS = 60000; // $600.00
const IRS_1099K_TRANSACTION_THRESHOLD = 200;
const IRS_1099K_AMOUNT_THRESHOLD_CENTS = 2000000; // $20,000.00

// Tax year (adjust for current year)
const TAX_YEAR = new Date().getFullYear();

// ============================================================================
// TYPES
// ============================================================================

export type W9Status = 'not_required' | 'requested' | 'received' | 'verified';
export type TaxFormType = 'W9' | 'W8BEN' | '1099NEC' | '1099K';
export type FilingStatus = 'pending' | 'filed' | 'corrected' | 'voided';

export interface WorkerTaxProfile {
  id: string;
  userId: string;
  taxYear: number;
  w9Status: W9Status;
  w9ReceivedAt: Date | null;
  w9Data: W9Data | null;
  nameOnAccount: string | null;
  tinLast4: string | null;
  tinType: 'SSN' | 'EIN' | null;
  addressVerified: boolean;
  backupWithholding: boolean;
  totalPaymentsCents: number;
  totalTransactions: number;
  platformFeesCents: number;
  refundsCents: number;
  netPaymentsCents: number;
  requires1099NEC: boolean;
  requires1099K: boolean;
  form1099NECStatus: FilingStatus | null;
  form1099KStatus: FilingStatus | null;
  stripeTaxFormId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface W9Data {
  name: string;
  businessName?: string;
  taxClassification: 'individual' | 'c_corp' | 's_corp' | 'partnership' | 'llc' | 'other';
  llcTaxClassification?: 'c_corp' | 's_corp' | 'partnership';
  exemptions?: {
    payeeCode?: string;
    fatcaCode?: string;
  };
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  tin: string; // SSN or EIN
  tinType: 'SSN' | 'EIN';
  signature: {
    signedBy: string;
    signedAt: Date;
    ipAddress: string;
  };
}

export interface PaymentTrackingEvent {
  userId: string;
  taskId: string;
  escrowId: string;
  grossAmountCents: number;
  platformFeeCents: number;
  netAmountCents: number;
  transactionType: 'payment' | 'refund' | 'adjustment';
  processedAt: Date;
}

export interface TaxThresholdAlert {
  userId: string;
  alertType: 'approaching_600' | 'exceeded_600' | 'approaching_200_transactions' | 'exceeded_20000';
  currentAmountCents: number;
  currentTransactions: number;
  thresholdCents: number;
  thresholdTransactions: number;
  actionRequired: string;
}

// ============================================================================
// WORKER TAX PROFILE MANAGEMENT
// ============================================================================

/**
 * Get or create worker tax profile for the current year.
 */
export async function getOrCreateWorkerTaxProfile(userId: string): Promise<WorkerTaxProfile | null> {
  const { sql } = await import('../db/index.js');

  try {
    // Try to get existing profile
    let [profile] = await sql`
      SELECT * FROM worker_earnings_1099
      WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
    `;

    if (!profile) {
      // Create new profile
      [profile] = await sql`
        INSERT INTO worker_earnings_1099 (
          user_id,
          tax_year,
          w9_status,
          total_payments_cents,
          total_transactions,
          platform_fees_cents,
          refunds_cents,
          net_payments_cents,
          requires_1099_nec,
          requires_1099_k,
          backup_withholding,
          created_at,
          updated_at
        ) VALUES (
          ${userId},
          ${TAX_YEAR},
          'not_required',
          0,
          0,
          0,
          0,
          0,
          FALSE,
          FALSE,
          FALSE,
          NOW(),
          NOW()
        )
        RETURNING *
      `;

      logger.info({ userId, taxYear: TAX_YEAR }, 'Created worker tax profile');
    }

    return formatWorkerTaxProfile(profile);
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to get/create worker tax profile');
    return null;
  }
}

/**
 * Submit W-9 information for a worker.
 */
export async function submitW9(
  userId: string,
  w9Data: W9Data
): Promise<{ success: boolean; error?: string }> {
  try {
    return await transaction(async (tx: any) => {
      // Validate TIN format
      const tinValidation = validateTIN(w9Data.tin, w9Data.tinType);
      if (!tinValidation.valid) {
        return { success: false, error: tinValidation.error };
      }

      // Store W-9 data (encrypt sensitive fields in production)
      await tx`
        INSERT INTO worker_earnings_1099 (
          user_id,
          tax_year,
          w9_status,
          w9_received_at,
          w9_data,
          name_on_account,
          tin_last4,
          tin_type,
          address_verified,
          updated_at
        ) VALUES (
          ${userId},
          ${TAX_YEAR},
          'received',
          NOW(),
          ${JSON.stringify({
            ...w9Data,
            tin: undefined, // Don't store raw TIN in JSON, use encrypted field
            tinEncrypted: encryptTIN(w9Data.tin),
          })},
          ${w9Data.name},
          ${w9Data.tin.slice(-4)},
          ${w9Data.tinType},
          TRUE,
          NOW()
        )
        ON CONFLICT (user_id, tax_year) DO UPDATE SET
          w9_status = 'received',
          w9_received_at = NOW(),
          w9_data = EXCLUDED.w9_data,
          name_on_account = EXCLUDED.name_on_account,
          tin_last4 = EXCLUDED.tin_last4,
          tin_type = EXCLUDED.tin_type,
          address_verified = TRUE,
          updated_at = NOW()
      `;

      logger.info({ userId, taxYear: TAX_YEAR }, 'W-9 submitted');

      // Trigger TIN verification (async)
      verifyTIN(userId, w9Data.tin, w9Data.tinType).catch(err => {
        logger.warn({ error: err, userId }, 'TIN verification failed');
      });

      return { success: true };
    });
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to submit W-9');
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Mark W-9 as verified after TIN verification.
 */
export async function markW9Verified(userId: string): Promise<void> {
  const { sql } = await import('../db/index.js');

  await sql`
    UPDATE worker_earnings_1099
    SET w9_status = 'verified', updated_at = NOW()
    WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
  `;

  logger.info({ userId }, 'W-9 marked as verified');
}

// ============================================================================
// PAYMENT TRACKING
// ============================================================================

/**
 * Track a payment for tax reporting purposes.
 * Called whenever a worker receives a payout.
 */
export async function trackPayment(event: PaymentTrackingEvent): Promise<void> {
  try {
    await transaction(async (tx: any) => {
      // Update worker earnings tracking
      await tx`
        INSERT INTO worker_earnings_1099 (
          user_id,
          tax_year,
          total_payments_cents,
          total_transactions,
          platform_fees_cents,
          net_payments_cents,
          requires_1099_nec,
          requires_1099_k,
          updated_at
        ) VALUES (
          ${event.userId},
          ${TAX_YEAR},
          ${event.grossAmountCents},
          1,
          ${event.platformFeeCents},
          ${event.netAmountCents},
          FALSE,
          FALSE,
          NOW()
        )
        ON CONFLICT (user_id, tax_year) DO UPDATE SET
          total_payments_cents = worker_earnings_1099.total_payments_cents + ${event.grossAmountCents},
          total_transactions = worker_earnings_1099.total_transactions + 1,
          platform_fees_cents = worker_earnings_1099.platform_fees_cents + ${event.platformFeeCents},
          net_payments_cents = worker_earnings_1099.total_payments_cents + ${event.grossAmountCents} 
                             - worker_earnings_1099.platform_fees_cents - COALESCE(worker_earnings_1099.refunds_cents, 0),
          updated_at = NOW()
      `;

      // Log the transaction
      await tx`
        INSERT INTO tax_payment_log (
          user_id,
          task_id,
          escrow_id,
          tax_year,
          gross_amount_cents,
          platform_fee_cents,
          net_amount_cents,
          transaction_type,
          processed_at
        ) VALUES (
          ${event.userId},
          ${event.taskId},
          ${event.escrowId},
          ${TAX_YEAR},
          ${event.grossAmountCents},
          ${event.platformFeeCents},
          ${event.netAmountCents},
          ${event.transactionType},
          ${event.processedAt}
        )
      `;

      // Check thresholds and send alerts
      await checkThresholds(tx, event.userId);
    });
  } catch (error: unknown) {
    logger.error({ error, event }, 'Failed to track payment for tax');
  }
}

/**
 * Check if worker has crossed tax reporting thresholds.
 */
async function checkThresholds(tx: any, userId: string): Promise<TaxThresholdAlert[]> {
  const [profile] = await tx`
    SELECT 
      total_payments_cents,
      total_transactions,
      w9_status
    FROM worker_earnings_1099
    WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
  `;

  if (!profile) return [];

  const alerts: TaxThresholdAlert[] = [];
  const payments = profile.total_payments_cents;
  const transactions = profile.total_transactions;

  // 1099-NEC threshold ($600)
  if (payments >= IRS_1099NEC_THRESHOLD_CENTS && profile.w9_status !== 'verified') {
    alerts.push({
      userId,
      alertType: 'exceeded_600',
      currentAmountCents: payments,
      currentTransactions: transactions,
      thresholdCents: IRS_1099NEC_THRESHOLD_CENTS,
      thresholdTransactions: 0,
      actionRequired: 'W-9 required for 1099-NEC reporting',
    });

    // Update requires_1099_nec flag
    await tx`
      UPDATE worker_earnings_1099
      SET requires_1099_nec = TRUE, updated_at = NOW()
      WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
    `;

    // Request W-9 if not already requested/received
    if (profile.w9_status === 'not_required') {
      await tx`
        UPDATE worker_earnings_1099
        SET w9_status = 'requested', updated_at = NOW()
        WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
      `;
    }
  } else if (payments >= IRS_1099NEC_THRESHOLD_CENTS * 0.8 && payments < IRS_1099NEC_THRESHOLD_CENTS) {
    alerts.push({
      userId,
      alertType: 'approaching_600',
      currentAmountCents: payments,
      currentTransactions: transactions,
      thresholdCents: IRS_1099NEC_THRESHOLD_CENTS,
      thresholdTransactions: 0,
      actionRequired: 'Approaching 1099-NEC threshold, prepare W-9',
    });
  }

  // 1099-K thresholds (200+ transactions OR $20,000)
  const requires1099K = transactions >= IRS_1099K_TRANSACTION_THRESHOLD || 
                        payments >= IRS_1099K_AMOUNT_THRESHOLD_CENTS;

  if (requires1099K) {
    alerts.push({
      userId,
      alertType: payments >= IRS_1099K_AMOUNT_THRESHOLD_CENTS ? 'exceeded_20000' : 'approaching_200_transactions',
      currentAmountCents: payments,
      currentTransactions: transactions,
      thresholdCents: IRS_1099K_AMOUNT_THRESHOLD_CENTS,
      thresholdTransactions: IRS_1099K_TRANSACTION_THRESHOLD,
      actionRequired: '1099-K reporting required',
    });

    await tx`
      UPDATE worker_earnings_1099
      SET requires_1099_k = TRUE, updated_at = NOW()
      WHERE user_id = ${userId} AND tax_year = ${TAX_YEAR}
    `;
  }

  // Log alerts
  for (const alert of alerts) {
    logger.warn({
      userId: alert.userId,
      alertType: alert.alertType,
      amount: alert.currentAmountCents,
    }, 'Tax threshold alert');
  }

  return alerts;
}

// ============================================================================
// 1099 FILING
// ============================================================================

/**
 * Generate 1099-NEC forms for all eligible workers.
 * Should be called in January for the previous tax year.
 */
export async function generate1099NECForms(taxYear: number): Promise<{
  generated: number;
  errors: string[];
}> {
  const { sql } = await import('../db/index.js');
  const errors: string[] = [];

  try {
    // Get all workers requiring 1099-NEC
    const workers = await sql`
      SELECT * FROM worker_earnings_1099
      WHERE tax_year = ${taxYear}
        AND requires_1099_nec = TRUE
        AND form_1099_nec_status IS NULL
        AND w9_status = 'verified'
    `;

    let generated = 0;

    for (const worker of workers) {
      try {
        // Generate 1099-NEC via Stripe Tax (or other provider)
        const formId = await generateStripe1099NEC(worker);

        await sql`
          UPDATE worker_earnings_1099
          SET 
            form_1099_nec_status = 'filed',
            stripe_tax_form_id = ${formId},
            updated_at = NOW()
          WHERE id = ${worker.id}
        `;

        generated++;
      } catch (error: unknown) {
        errors.push(`Worker ${worker.user_id}: ${getErrorMessage(error)}`);
      }
    }

    logger.info({ taxYear, generated, errors: errors.length }, '1099-NEC generation complete');

    return { generated, errors };
  } catch (error: unknown) {
    logger.error({ error, taxYear }, 'Failed to generate 1099-NEC forms');
    return { generated: 0, errors: [getErrorMessage(error)] };
  }
}

/**
 * Generate 1099-K forms for workers meeting thresholds.
 */
export async function generate1099KForms(taxYear: number): Promise<{
  generated: number;
  errors: string[];
}> {
  const { sql } = await import('../db/index.js');
  const errors: string[] = [];

  try {
    const workers = await sql`
      SELECT * FROM worker_earnings_1099
      WHERE tax_year = ${taxYear}
        AND requires_1099_k = TRUE
        AND form_1099_k_status IS NULL
    `;

    let generated = 0;

    for (const worker of workers) {
      try {
        const formId = await generateStripe1099K(worker);

        await sql`
          UPDATE worker_earnings_1099
          SET 
            form_1099_k_status = 'filed',
            stripe_tax_form_id = ${formId},
            updated_at = NOW()
          WHERE id = ${worker.id}
        `;

        generated++;
      } catch (error: unknown) {
        errors.push(`Worker ${worker.user_id}: ${getErrorMessage(error)}`);
      }
    }

    return { generated, errors };
  } catch (error: unknown) {
    logger.error({ error, taxYear }, 'Failed to generate 1099-K forms');
    return { generated: 0, errors: [getErrorMessage(error)] };
  }
}

// ============================================================================
// STRIPE INTEGRATION
// ============================================================================

/**
 * Generate 1099-NEC via Stripe Tax.
 */
async function generateStripe1099NEC(worker: any): Promise<string> {
  // TODO: Implement Stripe Tax 1099-NEC generation
  // This requires Stripe Tax to be configured
  logger.info({ userId: worker.user_id }, 'Stripe 1099-NEC generation not yet implemented');
  return `form_nec_${worker.user_id}_${Date.now()}`;
}

/**
 * Generate 1099-K via Stripe.
 */
async function generateStripe1099K(worker: any): Promise<string> {
  // TODO: Implement Stripe 1099-K generation
  logger.info({ userId: worker.user_id }, 'Stripe 1099-K generation not yet implemented');
  return `form_k_${worker.user_id}_${Date.now()}`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function validateTIN(tin: string, type: 'SSN' | 'EIN'): { valid: boolean; error?: string } {
  // Remove dashes
  const cleanTIN = tin.replace(/-/g, '');

  if (type === 'SSN') {
    // SSN: 9 digits, format XXX-XX-XXXX
    if (!/^\d{9}$/.test(cleanTIN)) {
      return { valid: false, error: 'SSN must be 9 digits' };
    }
  } else {
    // EIN: 9 digits, format XX-XXXXXXX
    if (!/^\d{9}$/.test(cleanTIN)) {
      return { valid: false, error: 'EIN must be 9 digits' };
    }
  }

  return { valid: true };
}

function encryptTIN(tin: string): string {
  // TODO: Implement proper encryption (e.g., AES-256)
  // For now, return a placeholder
  return `enc_${Buffer.from(tin).toString('base64')}`;
}

async function verifyTIN(userId: string, tin: string, type: 'SSN' | 'EIN'): Promise<void> {
  // TODO: Implement TIN verification via IRS TIN Match API
  logger.info({ userId, type }, 'TIN verification not yet implemented');
}

function formatWorkerTaxProfile(row: any): WorkerTaxProfile {
  return {
    id: row.id,
    userId: row.user_id,
    taxYear: row.tax_year,
    w9Status: row.w9_status,
    w9ReceivedAt: row.w9_received_at,
    w9Data: row.w9_data,
    nameOnAccount: row.name_on_account,
    tinLast4: row.tin_last4,
    tinType: row.tin_type,
    addressVerified: row.address_verified,
    backupWithholding: row.backup_withholding,
    totalPaymentsCents: row.total_payments_cents,
    totalTransactions: row.total_transactions,
    platformFeesCents: row.platform_fees_cents,
    refundsCents: row.refunds_cents,
    netPaymentsCents: row.net_payments_cents,
    requires1099NEC: row.requires_1099_nec,
    requires1099K: row.requires_1099_k,
    form1099NECStatus: row.form_1099_nec_status,
    form1099KStatus: row.form_1099_k_status,
    stripeTaxFormId: row.stripe_tax_form_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// REPORTING
// ============================================================================

/**
 * Get tax compliance dashboard data.
 */
export async function getTaxDashboard(taxYear: number = TAX_YEAR): Promise<{
  totalWorkers: number;
  requiring1099NEC: number;
  requiring1099K: number;
  w9Received: number;
  w9Pending: number;
  totalPaymentsCents: number;
  formsFiled: number;
  formsPending: number;
}> {
  const { sql } = await import('../db/index.js');

  const [summary] = await sql`
    SELECT 
      COUNT(*) as total_workers,
      COUNT(*) FILTER (WHERE requires_1099_nec = TRUE) as requiring_1099_nec,
      COUNT(*) FILTER (WHERE requires_1099_k = TRUE) as requiring_1099_k,
      COUNT(*) FILTER (WHERE w9_status = 'verified') as w9_received,
      COUNT(*) FILTER (WHERE w9_status IN ('requested', 'not_required')) as w9_pending,
      COALESCE(SUM(total_payments_cents), 0) as total_payments_cents,
      COUNT(*) FILTER (WHERE form_1099_nec_status = 'filed' OR form_1099_k_status = 'filed') as forms_filed,
      COUNT(*) FILTER (WHERE (requires_1099_nec = TRUE AND form_1099_nec_status IS NULL) 
                        OR (requires_1099_k = TRUE AND form_1099_k_status IS NULL)) as forms_pending
    FROM worker_earnings_1099
    WHERE tax_year = ${taxYear}
  `;

  return {
    totalWorkers: parseInt(summary.total_workers, 10),
    requiring1099NEC: parseInt(summary.requiring_1099_nec, 10),
    requiring1099K: parseInt(summary.requiring_1099_k, 10),
    w9Received: parseInt(summary.w9_received, 10),
    w9Pending: parseInt(summary.w9_pending, 10),
    totalPaymentsCents: parseInt(summary.total_payments_cents, 10),
    formsFiled: parseInt(summary.forms_filed, 10),
    formsPending: parseInt(summary.forms_pending, 10),
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const TaxComplianceService = {
  getOrCreateWorkerTaxProfile,
  submitW9,
  markW9Verified,
  trackPayment,
  generate1099NECForms,
  generate1099KForms,
  getTaxDashboard,
  // Constants
  IRS_1099NEC_THRESHOLD_CENTS,
  IRS_1099K_TRANSACTION_THRESHOLD,
  IRS_1099K_AMOUNT_THRESHOLD_CENTS,
};

export default TaxComplianceService;
