import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  send: vi.fn(),
  processed: vi.fn(),
  failed: vi.fn(),
  authorize: vi.fn(),
  cancelled: vi.fn(),
  deliveryFailed: vi.fn(),
  accepted: vi.fn(),
  suppressed: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/PushNotificationService.js', () => ({ sendPushNotification: mocks.send }));
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
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { workerLogger: log };
});

import { processPushJob } from '../../src/jobs/push-worker.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';

const PUSH_OUTBOX_KEY = 'push.send_requested:task:user:notification:1';
const job = {
  id: outboxTransportJobId(PUSH_OUTBOX_KEY),
  data: {
    aggregate_type: 'push',
    aggregate_id: 'notification-1',
    event_version: 1,
    payload: {
      notificationId: 'notification-1',
      userId: 'user-1',
      title: 'Title',
      body: 'Body',
      data: { deepLink: '/tasks/task-1' },
      _outbox_key: PUSH_OUTBOX_KEY,
    },
  },
} as unknown as Parameters<typeof processPushJob>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.query.mockResolvedValue({ rows: [{ id: 'outbox-1' }], rowCount: 1 });
  mocks.send.mockResolvedValue({ success: true, sent: 1, failed: 0 });
});

describe('push worker notification delivery contract', () => {
  it('rejects a forged transport ID before authorization, claim, or FCM', async () => {
    const forged = {
      ...job,
      id: outboxTransportJobId('push.send_requested:forged:1'),
    } as Parameters<typeof processPushJob>[0];
    await expect(processPushJob(forged)).rejects.toThrow('OUTBOX_IDENTITY_MISMATCH');
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('rechecks supersession before claiming or calling FCM', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'superseded' });
    await processPushJob(job);
    expect(mocks.cancelled).toHaveBeenCalledWith('notification-1', 'push', 'superseded');
    expect(mocks.processed).toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('records FCM acceptance without claiming device delivery', async () => {
    await processPushJob(job);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith('notification-1', 'push', 'fcm', null);
    expect(mocks.processed).toHaveBeenCalledWith(PUSH_OUTBOX_KEY);
  });

  it('suppresses a channel with no active device instead of retrying forever', async () => {
    mocks.send.mockResolvedValue({ success: true, sent: 0, failed: 0, reason: 'no_active_device' });
    await processPushJob(job);
    expect(mocks.suppressed).toHaveBeenCalledWith('notification-1', 'push', 'no_active_device');
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalled();
  });

  it('persists provider failure for bounded retry and rethrows', async () => {
    mocks.send.mockResolvedValue({ success: false, sent: 0, failed: 0, reason: 'provider_unconfigured' });
    await expect(processPushJob(job)).rejects.toThrow('provider_unconfigured');
    expect(mocks.failed).toHaveBeenCalled();
    expect(mocks.deliveryFailed).toHaveBeenCalledWith(
      'notification-1', 'push', expect.stringContaining('provider_unconfigured'),
    );
  });

  it('returns a not-due job to the outbox without burning a provider attempt', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reason: 'not_due' });
    await processPushJob(job);
    expect(mocks.failed).toHaveBeenCalledWith(PUSH_OUTBOX_KEY, 'notification_not_due');
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
