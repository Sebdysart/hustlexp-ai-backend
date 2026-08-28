import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));

import { db } from '../../src/db.js';
import {
  authorizeNotificationDelivery,
  markNotificationDelivered,
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
  markNotificationSuppressed,
} from '../../src/services/NotificationDeliveryState.js';

const mockDb = vi.mocked(db);

beforeEach(() => vi.clearAllMocks());

describe('notification delivery state authority', () => {
  it('fails closed when notification delivery evidence is missing', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({
      allowed: false,
      reason: 'delivery_missing',
    });
  });

  it.each([
    [{ superseded_at: new Date(), available_at: new Date(0), state: 'queued' }, 'superseded'],
    [{ superseded_at: null, available_at: new Date(Date.now() + 60_000), state: 'deferred_quiet_hours' }, 'not_due'],
    [{ superseded_at: null, available_at: new Date(0), state: 'cancelled_superseded' }, 'cancelled_superseded'],
    [{ superseded_at: null, available_at: new Date(0), state: 'failed_terminal' }, 'failed_terminal'],
  ])('refuses a non-sendable state: %s', async (row, reason) => {
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({ allowed: false, reason });
  });

  it('allows a due, unsuperseded, retryable delivery', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ superseded_at: null, available_at: new Date(0), state: 'queued' }],
      rowCount: 1,
    } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({ allowed: true });
  });

  it('records provider acceptance without fabricating delivery', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationProviderAccepted('n1', 'push', 'fcm', 'batch-1');
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("state = 'provider_accepted'");
    expect(sql).toContain('provider_accepted_at = NOW()');
    expect(sql).not.toContain('delivered_at = NOW()');
    expect(sql).toContain("state IN ('pending','deferred_quiet_hours','queued','retry_pending')");
    expect(sql).toContain("delivery_state IN ('delivered','partially_queued','failed_terminal')");
    expect(params).toEqual(['n1', 'push', 'fcm', 'batch-1']);
  });

  it('records suppression as terminal for that destination without calling it delivered', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationSuppressed('n1', 'email', 'user_do_not_email');
    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain("state = 'suppressed'");
    expect(sql).toContain('last_error = $3');
    expect(sql).not.toContain("state = 'delivered'");
  });

  it('records channel delivery without erasing an unresolved aggregate terminal exception', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationDelivered('n1', 'email', 'sg-1');
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("WHEN delivery_state = 'failed_terminal' THEN delivery_state");
    expect(sql).toContain('delivered_at = COALESCE(delivered_at, NOW())');
    expect(params).toEqual(['n1', 'email', 'sg-1']);
  });

  it('bounds retries and promotes exhaustion to operator-visible terminal failure', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationDeliveryFailure('n1', 'sms', 'provider_timeout');
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("THEN 'failed_terminal'");
    expect(sql).toContain("ELSE 'retry_pending'");
    expect(sql).toContain("terminal_visibility = 'operator_exception'");
    expect(sql).toContain('terminal_failure_at');
    expect(sql).toContain("notification.delivery_state = 'failed_terminal'");
    expect(sql).toContain('COALESCE(notification.terminal_failure_at, failed.terminal_failure_at)');
    expect(sql).toContain('COALESCE(notification.terminal_failure_reason');
    expect(params).toEqual(['n1', 'sms', 'provider_timeout']);
  });
});
