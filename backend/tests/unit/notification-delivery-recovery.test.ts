import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  retryDelivery: vi.fn(),
  deliveryFailed: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { retryDelivery: mocks.retryDelivery },
}));
vi.mock('../../src/services/NotificationDeliveryState.js', () => ({
  markNotificationDeliveryFailure: mocks.deliveryFailed,
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});

import { NotificationDeliveryRecoveryService } from '../../src/services/NotificationDeliveryRecoveryService.js';

beforeEach(() => vi.clearAllMocks());

describe('notification delivery recovery authority', () => {
  it('atomically releases Focus-deferred external work only after active execution ends', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ released: '2' }], rowCount: 1 });

    await expect(NotificationDeliveryRecoveryService.releaseFocusDeferred(10_000))
      .resolves.toEqual({ released: 2 });

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("notification.delivery_state = 'deferred_focus'");
    expect(sql).toContain("task.state = 'ACCEPTED'");
    expect(sql).toContain("task.progress_state IN ('ACCEPTED','TRAVELING','WORKING')");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("delivery.state = 'deferred_focus'");
    expect(sql).toContain("delivery.channel IN ('email','push','sms')");
    expect(sql).toContain("outbox.payload->'params'->>'notificationId'");
    expect(sql).toContain('focus_released_at = NOW()');
    expect(params).toEqual([100]);
  });

  it('selects only due retry rows that have no channel work record and bounds the batch', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await NotificationDeliveryRecoveryService.recoverDue(10_000);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("delivery.state = 'retry_pending'");
    expect(sql).toContain('delivery.next_retry_at <= NOW()');
    expect(sql).toContain('notification.superseded_at IS NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('email_outbox');
    expect(sql).toContain('sms_outbox');
    expect(sql).toContain("outbox.event_type = 'push.send_requested'");
    expect(params).toEqual([100]);
  });

  it('requeues eligible channels and records failed attempts without aborting the batch', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        { notification_id: 'n-email', channel: 'email' },
        { notification_id: 'n-sms', channel: 'sms' },
      ],
      rowCount: 2,
    });
    mocks.retryDelivery
      .mockResolvedValueOnce({ success: true, data: { queued: true } })
      .mockResolvedValueOnce({ success: false, error: { code: 'DB_ERROR', message: 'no phone' } });

    const result = await NotificationDeliveryRecoveryService.recoverDue(20);

    expect(mocks.retryDelivery).toHaveBeenNthCalledWith(1, 'n-email', 'email');
    expect(mocks.retryDelivery).toHaveBeenNthCalledWith(2, 'n-sms', 'sms');
    expect(mocks.deliveryFailed).toHaveBeenCalledWith('n-sms', 'sms', 'no phone');
    expect(result).toEqual({ inspected: 2, recovered: 1, failed: 1, skipped: 0 });
  });

  it('treats an eligibility race as a safe skip', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ notification_id: 'n-push', channel: 'push' }],
      rowCount: 1,
    });
    mocks.retryDelivery.mockResolvedValueOnce({ success: true, data: { queued: false } });

    await expect(NotificationDeliveryRecoveryService.recoverDue(5)).resolves.toEqual({
      inspected: 1, recovered: 0, failed: 0, skipped: 1,
    });
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
  });
});
