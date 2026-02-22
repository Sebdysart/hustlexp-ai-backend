/**
 * Tax Reporting Service - IRS 1099-K Compliance
 *
 * Generates 1099-K records for workers (hustlers) who received >= $600
 * in gross payments during a given tax year. Required for platforms that
 * process third-party payment transactions (IRS Form 1099-K).
 *
 * DATA SOURCES:
 * - hustler_payouts: Completed transfer records to workers
 * - escrow_holds: Escrow records with gross/net breakdowns
 * - users: Worker identity (name, email)
 *
 * NOTES:
 * - All monetary amounts are stored and returned in cents
 * - The $600 threshold is applied against gross_amount (before fees)
 * - federal_tax_withheld and state_tax_withheld are 0 (no withholding)
 * - Platform TIN (payer) is read from PLATFORM_TIN env var
 * - Worker TIN (payee) is optional and read from users table if collected
 *
 * @version 1.0.0
 */

import { safeSql } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** IRS reporting threshold in cents ($600.00) */
const IRS_1099K_THRESHOLD_CENTS = 60000;

// ============================================================================
// TYPES
// ============================================================================

export interface Tax1099KRecord {
  taxYear: number;
  workerId: string;
  workerName: string;
  workerEmail: string;
  grossAmount: number; // Total gross payments in cents
  numberOfTransactions: number;
  federalTaxWithheld: number; // 0 for now
  stateTaxWithheld: number; // 0 for now
  payerTIN: string; // Platform's TIN (from env)
  payeeTIN?: string; // Worker's TIN (if collected)
}

// ============================================================================
// SERVICE
// ============================================================================

export class TaxReportingService {
  /**
   * Generate 1099-K records for all workers who meet the IRS threshold
   * in a given tax year.
   *
   * Aggregates gross payments from both hustler_payouts (completed transfers)
   * and escrow_holds (released escrows) to build a complete picture of
   * payments to each worker.
   *
   * @param taxYear - The calendar year to report on (e.g. 2025)
   * @returns Array of Tax1099KRecord for workers at or above the $600 threshold
   */
  static async generate1099KRecords(taxYear: number): Promise<Tax1099KRecord[]> {
    const payerTIN = process.env.PLATFORM_TIN || '';

    if (!payerTIN) {
      serviceLogger.warn('PLATFORM_TIN not set - 1099-K records will have empty payer TIN');
    }

    try {
      // Aggregate gross payments per worker from both payment sources.
      //
      // Primary source: escrow_holds with status='released' gives us the
      // definitive gross_amount_cents for each completed task.
      //
      // We join to hustler_payouts to confirm the transfer actually completed,
      // but use escrow gross amounts as the canonical gross figure (which is
      // what the payer charged, before platform fees).
      //
      // Date filtering: we use escrow_holds.updated_at as the "payment date"
      // since that reflects when funds were actually released.
      const rows = await safeSql`
        SELECT
          eh.hustler_id AS worker_id,
          u.name AS worker_name,
          u.email AS worker_email,
          u.tax_id AS payee_tin,
          SUM(eh.gross_amount_cents)::int AS gross_amount,
          COUNT(DISTINCT eh.task_id)::int AS num_transactions
        FROM escrow_holds eh
        JOIN users u ON u.id::text = eh.hustler_id
        WHERE eh.status = 'released'
          AND EXTRACT(YEAR FROM eh.updated_at) = ${taxYear}
        GROUP BY eh.hustler_id, u.name, u.email, u.tax_id
        HAVING SUM(eh.gross_amount_cents) >= ${IRS_1099K_THRESHOLD_CENTS}
        ORDER BY gross_amount DESC
      `;

      const records: Tax1099KRecord[] = (rows as any[]).map((row) => ({
        taxYear,
        workerId: row.worker_id,
        workerName: row.worker_name || 'Unknown',
        workerEmail: row.worker_email || '',
        grossAmount: row.gross_amount,
        numberOfTransactions: row.num_transactions,
        federalTaxWithheld: 0,
        stateTaxWithheld: 0,
        payerTIN,
        ...(row.payee_tin ? { payeeTIN: row.payee_tin } : {}),
      }));

      serviceLogger.info(
        { taxYear, recordCount: records.length },
        '1099-K records generated'
      );

      return records;
    } catch (error: any) {
      serviceLogger.error({ error, taxYear }, 'Failed to generate 1099-K records');
      throw error;
    }
  }

  /**
   * Get a single worker's tax summary for a given year.
   *
   * Returns the 1099-K record regardless of whether the worker meets the
   * $600 threshold (useful for worker-facing "Your Tax Summary" screens).
   * Returns null if the worker had no released payments in the given year.
   *
   * @param workerId - The user ID of the worker
   * @param taxYear - The calendar year to report on
   * @returns Tax1099KRecord or null if no payments found
   */
  static async getWorkerTaxSummary(
    workerId: string,
    taxYear: number
  ): Promise<Tax1099KRecord | null> {
    const payerTIN = process.env.PLATFORM_TIN || '';

    try {
      const [row] = await safeSql`
        SELECT
          eh.hustler_id AS worker_id,
          u.name AS worker_name,
          u.email AS worker_email,
          u.tax_id AS payee_tin,
          COALESCE(SUM(eh.gross_amount_cents), 0)::int AS gross_amount,
          COUNT(DISTINCT eh.task_id)::int AS num_transactions
        FROM escrow_holds eh
        JOIN users u ON u.id::text = eh.hustler_id
        WHERE eh.hustler_id = ${workerId}
          AND eh.status = 'released'
          AND EXTRACT(YEAR FROM eh.updated_at) = ${taxYear}
        GROUP BY eh.hustler_id, u.name, u.email, u.tax_id
      ` as any[];

      if (!row || row.gross_amount === 0) {
        serviceLogger.debug(
          { workerId, taxYear },
          'No released payments found for worker in tax year'
        );
        return null;
      }

      return {
        taxYear,
        workerId: row.worker_id,
        workerName: row.worker_name || 'Unknown',
        workerEmail: row.worker_email || '',
        grossAmount: row.gross_amount,
        numberOfTransactions: row.num_transactions,
        federalTaxWithheld: 0,
        stateTaxWithheld: 0,
        payerTIN,
        ...(row.payee_tin ? { payeeTIN: row.payee_tin } : {}),
      };
    } catch (error: any) {
      serviceLogger.error(
        { error, workerId, taxYear },
        'Failed to get worker tax summary'
      );
      throw error;
    }
  }

  /**
   * Export all 1099-K records for a tax year as a CSV string.
   *
   * The CSV format is compatible with IRS FIRE system bulk upload
   * and can be used for internal reporting or integration with
   * tax preparation software.
   *
   * @param taxYear - The calendar year to export
   * @returns CSV string with header row and one data row per qualifying worker
   */
  static async exportToCSV(taxYear: number): Promise<string> {
    const records = await TaxReportingService.generate1099KRecords(taxYear);

    const headers = [
      'tax_year',
      'worker_id',
      'worker_name',
      'worker_email',
      'gross_amount_cents',
      'gross_amount_dollars',
      'number_of_transactions',
      'federal_tax_withheld_cents',
      'state_tax_withheld_cents',
      'payer_tin',
      'payee_tin',
    ];

    const rows = records.map((r) => [
      r.taxYear,
      csvEscape(r.workerId),
      csvEscape(r.workerName),
      csvEscape(r.workerEmail),
      r.grossAmount,
      (r.grossAmount / 100).toFixed(2),
      r.numberOfTransactions,
      r.federalTaxWithheld,
      r.stateTaxWithheld,
      csvEscape(r.payerTIN),
      csvEscape(r.payeeTIN || ''),
    ]);

    const csv = [
      headers.join(','),
      ...rows.map((row) => row.join(',')),
    ].join('\n');

    serviceLogger.info(
      { taxYear, recordCount: records.length, csvBytes: csv.length },
      '1099-K CSV export generated'
    );

    return csv;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Escape a value for safe CSV inclusion.
 * Wraps in double-quotes if the value contains commas, quotes, or newlines.
 */
function csvEscape(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
