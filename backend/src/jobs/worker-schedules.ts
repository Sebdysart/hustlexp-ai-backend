import { workerLogger as log } from '../logger.js';
import { enqueueRepeatableJob, type QueueName } from './queues.js';

async function addRepeatable(
  queueName: QueueName,
  jobName: string,
  payload: Record<string, unknown>,
  pattern: string
): Promise<void> {
  await enqueueRepeatableJob(queueName, jobName, payload, pattern);
}

export async function registerScheduledJobs(): Promise<void> {
  await addRepeatable('maintenance', 'dispatch.expire_unfilled', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'safety.escalate_overdue_checkins', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'safety.expire_location_evidence', { limit: 100 }, '15 * * * *');
  await addRepeatable('maintenance', 'media.expire_uploads', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'recurring.generate_due', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'recurring.advance_reservations', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'completion.complete_due', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'recover_stuck_stripe_events', { timeoutMinutes: 10 }, '*/10 * * * *');
  await addRepeatable('maintenance', 'cleanup_expired_exports', {}, '0 */6 * * *');
  await addRepeatable('maintenance', 'cleanup_expired_notifications', {}, '30 */6 * * *');
  await addRepeatable('maintenance', 'notification.recover_due', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'notification.release_focus_deferred', { limit: 100 }, '* * * * *');
  await addRepeatable('maintenance', 'notification.business_weekly_digest', { limit: 100 }, '0 15 * * 1');
  await addRepeatable('critical_trust', 'fraud.scan_requested', {}, '*/5 * * * *');
  await addRepeatable('expertise_recalc', 'expertise.recalculate_all', {}, '0 3 * * *');
  await addRepeatable('xp_tax_reminders', 'xp_tax.send_reminders', {}, '0 10 * * *');
  log.info('Scheduled repeatable jobs registered');
}
