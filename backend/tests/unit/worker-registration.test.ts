import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createWorker: vi.fn(),
  push: vi.fn(),
  email: vi.fn(),
  biometric: vi.fn(),
  expertise: vi.fn(),
  xpTax: vi.fn(),
  pushJob: vi.fn(),
  smsJob: vi.fn(),
  instantNotification: vi.fn(),
  realtime: vi.fn(),
  escrowAction: vi.fn(),
  completionRelease: vi.fn(),
  stripeEvent: vi.fn(),
  instantMatching: vi.fn(),
  instantSurge: vi.fn(),
  payment: vi.fn(),
  trust: vi.fn(),
  fraud: vi.fn(),
  maintenance: vi.fn(),
  tax: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger', () => ({ workerLogger: { info: mocks.info, error: mocks.error } }));
vi.mock('../../src/services/PushNotificationService', () => ({ sendPushNotification: mocks.push }));
vi.mock('../../src/jobs/queues', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/jobs/email-worker', () => ({ processEmailJob: mocks.email }));
vi.mock('../../src/jobs/biometric-analyzer-worker', () => ({ processBiometricAnalysisJob: mocks.biometric }));
vi.mock('../../src/jobs/expertise-recalc-worker', () => ({ processExpertiseRecalcJob: mocks.expertise }));
vi.mock('../../src/jobs/export-worker', () => ({ processExportJob: vi.fn() }));
vi.mock('../../src/jobs/xp-tax-reminder-worker', () => ({ processXPTaxReminderJob: mocks.xpTax }));
vi.mock('../../src/jobs/push-worker', () => ({ processPushJob: mocks.pushJob }));
vi.mock('../../src/jobs/sms-worker', () => ({ processSMSJob: mocks.smsJob }));
vi.mock('../../src/jobs/instant-notification-worker', () => ({ processInstantNotificationJob: mocks.instantNotification }));
vi.mock('../../src/jobs/realtime-worker', () => ({ processRealtimeJob: mocks.realtime }));
vi.mock('../../src/jobs/escrow-action-worker', () => ({ processEscrowActionJob: mocks.escrowAction }));
vi.mock('../../src/jobs/completion-release-worker', () => ({ processCompletionReleaseJob: mocks.completionRelease }));
vi.mock('../../src/jobs/stripe-event-worker', () => ({ processStripeEventJob: mocks.stripeEvent }));
vi.mock('../../src/jobs/instant-matching-worker', () => ({ processInstantMatchingJob: mocks.instantMatching }));
vi.mock('../../src/jobs/instant-surge-worker', () => ({ processInstantSurgeJob: mocks.instantSurge }));
vi.mock('../../src/jobs/payment-worker', () => ({ processPaymentJob: mocks.payment }));
vi.mock('../../src/jobs/trust-worker', () => ({ processTrustJob: mocks.trust }));
vi.mock('../../src/jobs/fraud-detection-worker', () => ({ processFraudDetectionJob: mocks.fraud }));
vi.mock('../../src/jobs/maintenance-worker', () => ({ processMaintenanceJob: mocks.maintenance }));
vi.mock('../../src/jobs/tax-reporting-worker', () => ({ processTaxReportingJob: mocks.tax }));

import type { Job, Worker } from 'bullmq';
import { registerWorkers } from '../../src/jobs/worker-registration';

type Handler = (job: Job) => Promise<void>;

function job(name: string, payload: Record<string, unknown> = {}): Job {
  return { name, data: { payload } } as Job;
}

function registeredHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  mocks.createWorker.mockImplementation((queue: string, handler: Handler) => {
    handlers.set(queue, handler);
    return { name: queue } as Worker;
  });
  const active: Worker[] = [];
  registerWorkers(active);
  expect(active).toHaveLength(9);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
});

describe('worker registration executable routing', () => {
  it('routes every notification event and inferred legacy payload', async () => {
    const handler = registeredHandlers().get('user_notifications')!;
    mocks.query.mockResolvedValue({ rows: [{ poster_id: 'poster-1' }], rowCount: 1 });

    await handler(job('email.send_requested'));
    await handler(job('push.send_requested'));
    await handler(job('sms.send_requested'));
    await handler(job('task.instant_available'));
    await handler(job('task.progress_updated'));
    await handler(job('escrow.funded', { escrowId: 'esc-1' }));
    await handler(job('escrow.refunded', { escrowId: 'esc-2' }));
    await handler(job('escrow.payment_failed', { escrowId: 'esc-3', posterId: 'poster-1', taskId: 'task-1' }));
    await handler(job('legacy.email', { emailId: 'email-1' }));
    await handler(job('legacy.sms', { smsId: 'sms-1' }));
    await handler(job('legacy.push', { notificationId: 'notification-1' }));
    await handler(job('unimplemented'));

    expect(mocks.email).toHaveBeenCalledTimes(2);
    expect(mocks.pushJob).toHaveBeenCalledTimes(2);
    expect(mocks.smsJob).toHaveBeenCalledTimes(2);
    expect(mocks.instantNotification).toHaveBeenCalledOnce();
    expect(mocks.realtime).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledTimes(3);
    expect(mocks.info).toHaveBeenCalledWith(
      { eventType: 'unimplemented' },
      'Notification type not yet implemented',
    );
  });

  it('does not notify when escrow or failed-payment ownership is absent', async () => {
    const handler = registeredHandlers().get('user_notifications')!;
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await handler(job('escrow.funded', { escrowId: 'esc-1' }));
    await handler(job('escrow.payment_failed', { escrowId: 'esc-2', posterId: null, taskId: 'task-1' }));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('routes all payment events and fails loud for unknown money work', async () => {
    const handler = registeredHandlers().get('critical_payments')!;
    for (const name of [
      'escrow.release_requested',
      'escrow.refund_requested',
      'escrow.partial_refund_requested',
    ]) await handler(job(name));
    await handler(job('escrow.completion_release_requested'));
    await handler(job('stripe.event_received'));
    await handler(job('task.instant_matching_started'));
    await handler(job('task.instant_surge_evaluate'));
    await handler(job('payment.capture_requested'));

    expect(mocks.escrowAction).toHaveBeenCalledTimes(3);
    expect(mocks.completionRelease).toHaveBeenCalledOnce();
    expect(mocks.stripeEvent).toHaveBeenCalledOnce();
    expect(mocks.instantMatching).toHaveBeenCalledOnce();
    expect(mocks.instantSurge).toHaveBeenCalledOnce();
    expect(mocks.payment).toHaveBeenCalledOnce();
    await expect(handler(job('unknown.money'))).rejects.toThrow('Unknown event type');
    expect(mocks.error).toHaveBeenCalled();
  });

  it('routes all trust events and fails loud for unknown trust work', async () => {
    const handler = registeredHandlers().get('critical_trust')!;
    await handler(job('trust.dispute_resolved.worker'));
    await handler(job('trust.dispute_resolved.poster'));
    await handler(job('fraud.scan_requested'));
    expect(mocks.trust).toHaveBeenCalledTimes(2);
    expect(mocks.fraud).toHaveBeenCalledOnce();
    await expect(handler(job('unknown.trust'))).rejects.toThrow('Unknown event type');
    expect(mocks.error).toHaveBeenCalled();
  });

  it('executes the dynamically registered maintenance and tax handlers', async () => {
    const handlers = registeredHandlers();
    await handlers.get('maintenance')!(job('dispatch.expire_unfilled'));
    await handlers.get('tax_reporting')!(job('tax.annual_filing_requested'));
    expect(mocks.maintenance).toHaveBeenCalledOnce();
    expect(mocks.tax).toHaveBeenCalledOnce();
  });
});
