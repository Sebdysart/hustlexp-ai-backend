import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  txQuery: vi.fn(),
  send: vi.fn(),
  processed: vi.fn(),
  failed: vi.fn(),
  authorize: vi.fn(),
  claim: vi.fn(),
  cancelled: vi.fn(),
  deliveryFailed: vi.fn(),
  accepted: vi.fn(),
  outcomeUnknown: vi.fn(),
  suppressed: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/services/PushNotificationService.js', () => ({ sendPushNotification: mocks.send }));
vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: mocks.processed,
  markOutboxEventFailed: mocks.failed,
}));
vi.mock('../../src/services/NotificationDeliveryState.js', () => ({
  authorizeNotificationDelivery: mocks.authorize,
  claimNotificationDelivery: mocks.claim,
  markNotificationCancelled: mocks.cancelled,
  markNotificationDeliveryFailure: mocks.deliveryFailed,
  markNotificationProviderAccepted: mocks.accepted,
  markNotificationProviderOutcomeUnknown: mocks.outcomeUnknown,
  markNotificationSuppressed: mocks.suppressed,
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { workerLogger: log };
});

import { processPushJob } from '../../src/jobs/push-worker.js';

const job = {
  id: 'push-job-1',
  data: {
    aggregate_type: 'push',
    aggregate_id: 'notification-1',
    event_version: 1,
    outbox_idempotency_key: 'push.send_requested:task:user:notification:1',
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000201',
    outbox_bullmq_job_id: 'push-job-1',
    payload: {
      notificationId: 'notification-1',
      userId: 'user-1',
      title: 'Title',
      body: 'Body',
      data: { deepLink: '/tasks/task-1' },
    },
  },
} as never;

const canonicalPush = {
  id: 'outbox-1',
  aggregate_id: 'notification-1',
  aggregate_type: 'push',
  event_version: 1,
  idempotency_key: 'push.send_requested:task:user:notification:1',
  dispatch_attempt_id: '00000000-0000-4000-8000-000000000201',
  bullmq_job_id: 'push-job-1',
  payload: {
    notificationId: 'notification-1',
    userId: 'user-1',
    title: 'Title',
    body: 'Body',
    data: { deepLink: '/tasks/task-1' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.claim.mockResolvedValue({ allowed: true, claimToken: '00000000-0000-4000-8000-000000000001' });
  mocks.outcomeUnknown.mockResolvedValue(true);
  mocks.query
    .mockResolvedValueOnce({ rows: [canonicalPush], rowCount: 1 })
    .mockResolvedValue({ rows: [{ id: 'outbox-1' }], rowCount: 1 });
  mocks.txQuery.mockResolvedValue({ rows: [{ id: 'outbox-1' }], rowCount: 1 });
  mocks.transaction.mockImplementation((fn: (query: typeof mocks.txQuery) => unknown) => fn(mocks.txQuery));
  mocks.send.mockResolvedValue({ success: true, sent: 1, failed: 0 });
});

describe('push worker notification delivery contract', () => {
  it('rejects a tampered Redis payload before state mutation or provider I/O', async () => {
    const tamperedJob = {
      id: 'push-job-1',
      data: {
        ...job.data,
        payload: { ...canonicalPush.payload, body: 'Injected body' },
      },
    } as never;

    await expect(processPushJob(tamperedJob)).rejects.toThrow(
      'Push job does not match canonical outbox authority',
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('rechecks supersession before claiming or calling FCM', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'superseded' });
    await processPushJob(job);
    expect(mocks.cancelled).toHaveBeenCalledWith('notification-1', 'push', 'superseded');
    expect(mocks.processed).toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not process or send when another worker owns an active pre-provider lease', async () => {
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [canonicalPush], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processPushJob(job);

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('does not let an expired claimant fail or rearm a successor dispatch', async () => {
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [canonicalPush], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }], rowCount: 1 });
    mocks.txQuery.mockReset();
    mocks.txQuery
      .mockRejectedValueOnce(new Error('resumed after local lease expiry'))
      .mockResolvedValueOnce({ rows: [{ id: 'notification-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processPushJob(job)).resolves.toBeUndefined();

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('records FCM acceptance without claiming device delivery', async () => {
    await processPushJob(job);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1',
      'push',
      'fcm',
      null,
      '00000000-0000-4000-8000-000000000001',
    );
    expect(mocks.processed).toHaveBeenCalledWith(
      job.data.outbox_idempotency_key,
      expect.objectContaining({ bullmqJobId: job.id }),
    );
  });

  it('suppresses a channel with no active device instead of retrying forever', async () => {
    mocks.send.mockResolvedValue({ success: true, sent: 0, failed: 0, reason: 'no_active_device' });
    await processPushJob(job);
    expect(mocks.suppressed).toHaveBeenCalledWith(
      'notification-1',
      'push',
      'no_active_device',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalled();
  });

  it('durably retries a known pre-I/O provider configuration failure', async () => {
    mocks.send.mockResolvedValue({ success: false, sent: 0, failed: 0, reason: 'provider_unconfigured' });
    await expect(processPushJob(job)).resolves.toBeUndefined();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.deliveryFailed).toHaveBeenCalledWith(
      'notification-1',
      'push',
      'Push provider unconfigured before I/O',
      '00000000-0000-4000-8000-000000000001',
      mocks.txQuery,
    );
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
  });

  it('records a post-I/O provider error as outcome unknown without retrying', async () => {
    mocks.send.mockResolvedValue({ success: false, sent: 0, failed: 1, reason: 'provider_error' });

    await expect(processPushJob(job)).resolves.toBeUndefined();

    expect(mocks.outcomeUnknown).toHaveBeenCalledWith(
      'notification-1',
      'push',
      expect.stringContaining('provider_error'),
      '00000000-0000-4000-8000-000000000001',
      mocks.txQuery,
    );
    expect(mocks.processed).toHaveBeenCalledWith(
      job.data.outbox_idempotency_key,
      expect.any(Object),
      { query: mocks.txQuery },
    );
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
  });

  it('returns a not-due job to the outbox without burning a provider attempt', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'not_due' });
    await processPushJob(job);
    expect(mocks.failed).toHaveBeenCalledWith(
      job.data.outbox_idempotency_key,
      'notification_not_due',
      expect.objectContaining({ bullmqJobId: job.id }),
    );
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
