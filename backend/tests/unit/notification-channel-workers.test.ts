import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  txQuery: vi.fn(),
  sendgridSend: vi.fn(),
  sendgridSetKey: vi.fn(),
  breakerExecute: vi.fn(),
  sendSms: vi.fn(),
  processed: vi.fn(),
  failed: vi.fn(),
  authorize: vi.fn(),
  cancelled: vi.fn(),
  deliveryFailed: vi.fn(),
  accepted: vi.fn(),
  suppressed: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/config.js', () => ({
  config: {
    identity: {
      sendgrid: { apiKey: 'SG.test', fromEmail: 'no-reply@hustlexp.test' },
    },
  },
}));
vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: mocks.sendgridSetKey, send: mocks.sendgridSend },
}));
vi.mock('../../src/middleware/circuit-breaker.js', () => ({
  sendgridBreaker: { execute: mocks.breakerExecute },
}));
vi.mock('../../src/services/TwilioSMSService.js', () => ({ sendSMS: mocks.sendSms }));
vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: mocks.processed,
  markOutboxEventFailed: mocks.failed,
}));
vi.mock('../../src/services/NotificationDeliveryState.js', () => ({
  authorizeNotificationDelivery: mocks.authorize,
  markNotificationCancelled: mocks.cancelled,
  markNotificationDeliveryFailure: mocks.deliveryFailed,
  markNotificationProviderAccepted: mocks.accepted,
  markNotificationSuppressed: mocks.suppressed,
}));
vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: mocks.notifyAdmins,
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { workerLogger: log };
});

import { processEmailJob } from '../../src/jobs/email-worker.js';
import { processSMSJob } from '../../src/jobs/sms-worker.js';

const emailJob = {
  id: 'email.send_requested:email-1',
  data: {
    aggregate_type: 'email',
    aggregate_id: 'email-1',
    event_version: 1,
    payload: {
      emailId: 'email-1',
      userId: 'user-1',
      toEmail: 'worker@example.test',
      template: 'notification',
      params: {
        notificationId: 'notification-1',
        title: 'Task update',
        body: 'The task changed.',
      },
    },
  },
} as never;

const smsJob = {
  id: 'sms.send_requested:sms-1',
  data: {
    aggregate_type: 'sms',
    aggregate_id: 'sms-1',
    event_version: 1,
    payload: {
      smsId: 'sms-1',
      notificationId: 'notification-1',
      userId: 'user-1',
      toPhone: '+15555550100',
      body: 'Task HX7A changed. Open HustleXP.',
    },
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.transaction.mockImplementation((fn: (query: typeof mocks.txQuery) => unknown) => fn(mocks.txQuery));
  mocks.breakerExecute.mockImplementation((fn: () => unknown) => fn());
});

describe.each([
  {
    channel: 'email',
    process: () => processEmailJob(emailJob),
    provider: mocks.sendgridSend,
  },
  {
    channel: 'sms',
    process: () => processSMSJob(smsJob),
    provider: mocks.sendSms,
  },
] as const)('$channel notification worker authorization', ({ channel, process, provider }) => {
  it('cancels a superseded delivery before any database claim or provider contact', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'superseded' });

    await process();

    expect(mocks.authorize).toHaveBeenCalledWith('notification-1', channel);
    expect(mocks.cancelled).toHaveBeenCalledWith('notification-1', channel, 'superseded');
    expect(mocks.processed).toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('defers a not-due delivery without burning a provider attempt', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'not_due' });

    await process();

    expect(mocks.failed).toHaveBeenCalledWith(expect.any(String), 'notification_not_due');
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('provider acceptance evidence', () => {
  it('records SendGrid acceptance without claiming mailbox delivery', async () => {
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'email-1', user_id: 'user-1', to_email: 'worker@example.test',
          template: 'notification', params_json: {}, status: 'pending', attempts: 0,
          max_attempts: 3, suppressed_reason: null, idempotency_key: 'email-key-1',
          provider_msg_id: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1', status: 'sending', attempts: 1 }], rowCount: 1 });
    mocks.query
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-1', status: 'sent', provider_msg_id: 'sg-message-1' }],
        rowCount: 1,
      });
    mocks.sendgridSend.mockResolvedValue([{ headers: { 'x-message-id': 'sg-message-1' } }]);

    await processEmailJob(emailJob);

    expect(mocks.sendgridSend).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1', 'email', 'sendgrid', 'sg-message-1',
    );
    expect(mocks.processed).toHaveBeenCalledWith('email-key-1');
  });

  it('records Twilio acceptance without claiming handset delivery', async () => {
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'sms-1', user_id: 'user-1', to_phone: '+15555550100',
          body: 'Task HX7A changed. Open HustleXP.', status: 'pending', retry_count: 0,
          max_retries: 3, idempotency_key: 'sms-key-1', twilio_sid: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1', status: 'sending', retry_count: 1 }], rowCount: 1 });
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'sms-1', status: 'sent', twilio_sid: 'SM123' }],
        rowCount: 1,
      });
    mocks.sendSms.mockResolvedValue({ success: true, sid: 'SM123' });

    await processSMSJob(smsJob);

    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1', 'sms', 'twilio', 'SM123',
    );
    expect(mocks.processed).toHaveBeenCalledWith('sms-key-1');
  });
});
