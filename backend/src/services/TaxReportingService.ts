/**
 * TaxReportingService v1.0.0
 *
 * Handles 1099-NEC tax reporting for workers earning >$600/year.
 * Integrates with Stripe Tax Reporting API for form generation.
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { logger } from '../logger';

const log = logger.child({ service: 'TaxReportingService' });

const REPORTING_THRESHOLD_CENTS = 60000; // $600.00

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
                SUM(e.amount)::BIGINT as total_earnings_cents,
                COUNT(DISTINCT t.id)::INTEGER as task_count
         FROM tasks t
         JOIN escrows e ON e.task_id = t.id
         WHERE e.state = 'RELEASED'
           AND EXTRACT(YEAR FROM e.released_at) = $1
           AND t.worker_id IS NOT NULL
         GROUP BY t.worker_id
         HAVING SUM(e.amount) >= $2
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
};
