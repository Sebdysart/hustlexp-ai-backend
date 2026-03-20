/**
 * TaxReportingService v1.0.0
 *
 * Handles 1099-NEC tax reporting for workers earning >$600/year.
 * Integrates with Stripe Tax Reporting API for form generation.
 */

import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import Stripe from 'stripe';

const log = logger.child({ service: 'TaxReportingService' });

const REPORTING_THRESHOLD_CENTS = 60000; // $600.00

// Lazy Stripe init to avoid startup issues if key not configured
let stripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (!stripe && config.stripe.secretKey) {
    stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });
  }
  return stripe;
}

interface TaxFiling {
  id: string;
  user_id: string;
  tax_year: number;
  form_type: string;
  total_earnings_cents: number;
  stripe_tax_form_id: string | null;
  status: string;
  filed_at: Date | null;
  created_at: Date;
}

interface WorkerEarnings {
  user_id: string;
  total_earnings_cents: number;
  task_count: number;
}

export const TaxReportingService = {
  /**
   * Get workers with earnings above 1099-NEC threshold for a tax year
   */
  getWorkersAboveThreshold: async (taxYear: number): Promise<ServiceResult<WorkerEarnings[]>> => {
    try {
      const result = await db.query<WorkerEarnings>(
        `SELECT t.worker_id as user_id,
                SUM(ROUND(e.amount * (1.0 - 15 / 100.0)))::BIGINT as total_earnings_cents,
                COUNT(DISTINCT t.id)::INTEGER as task_count
         FROM tasks t
         JOIN escrows e ON e.task_id = t.id
         WHERE e.state = 'RELEASED'
           AND EXTRACT(YEAR FROM e.released_at) = $1
           AND t.worker_id IS NOT NULL
         GROUP BY t.worker_id
         HAVING SUM(ROUND(e.amount * (1.0 - 15 / 100.0))) >= $2
         ORDER BY total_earnings_cents DESC`,
        [taxYear, REPORTING_THRESHOLD_CENTS]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  /**
   * Create or update a tax filing record
   */
  createTaxFiling: async (userId: string, taxYear: number, totalEarningsCents: number): Promise<ServiceResult<TaxFiling>> => {
    try {
      const result = await db.query<TaxFiling>(
        `INSERT INTO tax_filings (user_id, tax_year, total_earnings_cents, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (user_id, tax_year, form_type) DO UPDATE SET
           total_earnings_cents = EXCLUDED.total_earnings_cents,
           updated_at = NOW()
         WHERE tax_filings.status = 'pending'
         RETURNING *`,
        [userId, taxYear, totalEarningsCents]
      );
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  /**
   * Get 1099 filing status for a user
   */
  get1099Status: async (userId: string, taxYear?: number): Promise<ServiceResult<TaxFiling[]>> => {
    try {
      const year = taxYear || new Date().getFullYear();
      const result = await db.query<TaxFiling>(
        `SELECT * FROM tax_filings WHERE user_id = $1 AND tax_year = $2 ORDER BY created_at DESC`,
        [userId, year]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  /**
   * Process all tax filings for a given year (admin/cron triggered)
   */
  processAnnualFilings: async (taxYear: number): Promise<ServiceResult<{ processed: number; errors: number }>> => {
    try {
      const workersResult = await TaxReportingService.getWorkersAboveThreshold(taxYear);
      if (!workersResult.success) return { success: false, error: workersResult.error };

      let processed = 0;
      let errors = 0;

      for (const worker of workersResult.data) {
        const filingResult = await TaxReportingService.createTaxFiling(
          worker.user_id,
          taxYear,
          Number(worker.total_earnings_cents)
        );
        if (filingResult.success) {
          processed++;
        } else {
          errors++;
          log.error({ userId: worker.user_id, err: filingResult.error.message }, 'Failed to create tax filing');
        }
      }

      log.info({ taxYear, processed, errors, totalWorkers: workersResult.data.length }, 'Annual tax filing processing complete');
      return { success: true, data: { processed, errors } };
    } catch (error) {
      return { success: false, error: { code: 'PROCESSING_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  /**
   * Generate 1099-NEC form via Stripe Tax Reporting API
   * Requires the worker to have a Stripe Connect account.
   */
  generate1099Form: async (userId: string, taxYear: number): Promise<ServiceResult<{ formId: string; status: string }>> => {
    try {
      const s = getStripe();
      if (!s) {
        log.warn({ userId, taxYear }, '1099 generation skipped — Stripe not configured');
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe API key not configured' } };
      }

      // Get worker's Stripe Connect account
      const userResult = await db.query<{ stripe_connect_id: string | null }>(
        `SELECT stripe_connect_id FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0 || !userResult.rows[0].stripe_connect_id) {
        return { success: false, error: { code: 'NO_CONNECT_ACCOUNT', message: 'Worker has no Stripe Connect account' } };
      }

      const connectId = userResult.rows[0].stripe_connect_id;

      // Get filing record for earnings data
      const filingResult = await db.query<TaxFiling>(
        `SELECT * FROM tax_filings WHERE user_id = $1 AND tax_year = $2 ORDER BY created_at DESC LIMIT 1`,
        [userId, taxYear]
      );

      if (filingResult.rows.length === 0) {
        return { success: false, error: { code: 'NO_FILING', message: 'No tax filing record found — run processAnnualFilings first' } };
      }

      // Use Stripe Tax Forms API via raw request (SDK types may not include forms resource)
      // Stripe handles form generation and IRS e-filing for Connect platforms
      const taxForm = await (s as unknown as { rawRequest: (method: string, path: string, params: Record<string, string>) => Promise<{ body: string }> }).rawRequest(
        'POST',
        '/v1/tax/forms',
        {
          type: '1099_nec',
          account: connectId,
          tax_year: taxYear.toString(),
        }
      ).then((res: { body: string }) => JSON.parse(res.body)).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err), connectId, taxYear }, 'Stripe Tax Form API call failed');
        return null;
      });

      if (!taxForm) {
        return { success: false, error: { code: 'STRIPE_API_ERROR', message: 'Failed to create 1099-NEC form via Stripe' } };
      }

      // Update filing record with Stripe form ID
      await db.query(
        `UPDATE tax_filings SET stripe_tax_form_id = $1, status = 'generated', updated_at = NOW()
         WHERE user_id = $2 AND tax_year = $3`,
        [taxForm.id, userId, taxYear]
      );

      log.info({ userId, taxYear, formId: taxForm.id }, '1099-NEC form generated via Stripe');
      return { success: true, data: { formId: taxForm.id, status: 'generated' } };
    } catch (error) {
      log.error({ userId, taxYear, err: error instanceof Error ? error.message : 'unknown' }, 'Failed to generate 1099 form');
      return { success: false, error: { code: 'FORM_GENERATION_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  /**
   * Check if a worker is approaching the 1099 threshold and return notification status
   */
  checkThresholdApproaching: async (userId: string, taxYear?: number): Promise<ServiceResult<{
    totalEarnings: number;
    threshold: number;
    percentOfThreshold: number;
    notificationLevel: 'none' | 'approaching' | 'near' | 'exceeded';
  }>> => {
    try {
      const year = taxYear || new Date().getFullYear();

      const result = await db.query<{ total_earnings_cents: string }>(
        `SELECT COALESCE(SUM(ROUND(e.amount * (1.0 - 15 / 100.0))), 0)::BIGINT as total_earnings_cents
         FROM tasks t
         JOIN escrows e ON e.task_id = t.id
         WHERE e.state = 'RELEASED'
           AND EXTRACT(YEAR FROM e.released_at) = $1
           AND t.worker_id = $2`,
        [year, userId]
      );

      const totalEarnings = parseInt(result.rows[0]?.total_earnings_cents || '0', 10);
      const percentOfThreshold = Math.round((totalEarnings / REPORTING_THRESHOLD_CENTS) * 100);

      let notificationLevel: 'none' | 'approaching' | 'near' | 'exceeded' = 'none';
      if (percentOfThreshold >= 100) notificationLevel = 'exceeded';
      else if (percentOfThreshold >= 90) notificationLevel = 'near';
      else if (percentOfThreshold >= 80) notificationLevel = 'approaching';

      return {
        success: true,
        data: {
          totalEarnings,
          threshold: REPORTING_THRESHOLD_CENTS,
          percentOfThreshold,
          notificationLevel,
        },
      };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },
};
