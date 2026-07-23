import { workerLogger as log } from '../logger.js';
import { getQueue, type QueueName } from './queues.js';

async function addRepeatable(
  queueName: QueueName,
  jobName: string,
  payload: Record<string, unknown>,
  pattern: string
): Promise<void> {
  await getQueue(queueName).add(jobName, payload, { repeat: { pattern } });
}

export async function registerScheduledJobs(): Promise<void> {
  await addRepeatable('maintenance', 'dispatch.expire_unfilled', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'recover_stuck_stripe_events', { timeoutMinutes: 10 }, '*/10 * * * *');
  await addRepeatable('maintenance', 'cleanup_expired_exports', {}, '0 */6 * * *');
  await addRepeatable('maintenance', 'cleanup_expired_notifications', {}, '30 */6 * * *');
  await addRepeatable('critical_trust', 'fraud.scan_requested', {}, '*/5 * * * *');
  await addRepeatable('expertise_recalc', 'expertise.recalculate_all', {}, '0 3 * * *');
  await addRepeatable('xp_tax_reminders', 'xp_tax.send_reminders', {}, '0 10 * * *');
  log.info('Scheduled repeatable jobs registered');
}
