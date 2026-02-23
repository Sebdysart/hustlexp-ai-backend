/**
 * Tax Reporting Worker
 * Processes annual 1099-NEC filings
 */

import type { Job } from 'bullmq';
import { TaxReportingService } from '../services/TaxReportingService';
import { workerLogger } from '../logger';

const log = workerLogger.child({ worker: 'tax-reporting' });

export async function processTaxReportingJob(job: Job): Promise<void> {
  const { taxYear } = job.data as { taxYear: number };

  log.info({ taxYear }, 'Starting tax reporting job');

  const result = await TaxReportingService.processAnnualFilings(taxYear);

  if (!result.success) {
    log.error({ taxYear, err: result.error.message }, 'Tax reporting job failed');
    throw new Error(result.error.message);
  }

  log.info({ taxYear, processed: result.data.processed, errors: result.data.errors }, 'Tax reporting job completed');
}
