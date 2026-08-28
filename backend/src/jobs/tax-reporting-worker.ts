/**
 * Tax Reporting Worker
 * Processes annual 1099-NEC filings
 */

import { z } from 'zod';
import type { Job } from 'bullmq';
import { TaxReportingService } from '../services/TaxReportingService.js';
import { workerLogger } from '../logger.js';

const log = workerLogger.child({ worker: 'tax-reporting' });

const TaxReportingJobSchema = z.object({
  taxYear: z.number().int().min(2000).max(2100),
});

export async function processTaxReportingJob(job: Job): Promise<void> {
  const parsed = TaxReportingJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new Error(`Invalid tax reporting job payload: ${parsed.error.message}`);
  }
  const { taxYear } = parsed.data;

  log.info({ taxYear }, 'Starting tax reporting job');

  const result = await TaxReportingService.processAnnualFilings(taxYear);

  if (!result.success) {
    log.error({ taxYear, err: result.error.message }, 'Tax reporting job failed');
    throw new Error(result.error.message);
  }

  log.info({ taxYear, processed: result.data.processed, errors: result.data.errors }, 'Tax reporting job completed');
}
