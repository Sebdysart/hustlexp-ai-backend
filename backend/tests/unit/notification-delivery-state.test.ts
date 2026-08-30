import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return { db: { query, transaction: vi.fn((fn) => fn(query)) } };
});

import { db } from '../../src/db.js';
import {
  authorizeNotificationDelivery,
  claimNotificationDelivery,
  markNotificationCancelled,
  markNotificationDelivered,
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
  markNotificationProviderOutcomeUnknown,
  markNotificationSuppressed,
} from '../../src/services/NotificationDeliveryState.js';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 } as never);
});

describe('notification delivery state authority', () => {
  it('fails closed when notification delivery evidence is missing', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({
      allowed: false,
      reason: 'delivery_missing',
    });
  });

  it.each([
    [{ superseded_at: new Date(), expires_at: null, available_at: new Date(0), state: 'queued' }, 'superseded'],
    [{ superseded_at: null, expires_at: new Date(0), available_at: new Date(0), state: 'queued' }, 'expired'],
    [{ superseded_at: null, expires_at: 'invalid', available_at: new Date(0), state: 'queued' }, 'expired'],
    [{ superseded_at: null, expires_at: null, available_at: new Date(Date.now() + 60_000), state: 'deferred_quiet_hours' }, 'not_due'],
    [{ superseded_at: null, expires_at: null, available_at: new Date(0), state: 'cancelled_superseded' }, 'cancelled_superseded'],
    [{ superseded_at: null, expires_at: null, available_at: new Date(0), state: 'failed_terminal' }, 'failed_terminal'],
  ])('refuses a non-sendable state: %s', async (row, reason) => {
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({ allowed: false, reason });
  });

  it('preserves unresolved provider truth ahead of supersession or expiry policy', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        superseded_at: new Date(),
        expires_at: new Date(0),
        available_at: new Date(0),
        state: 'provider_outcome_unknown',
      }],
      rowCount: 1,
    } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({
      allowed: false,
      reason: 'provider_outcome_unknown',
    });
  });

  it('allows a due, unsuperseded, retryable delivery', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ superseded_at: null, expires_at: null, available_at: new Date(0), state: 'queued' }],
      rowCount: 1,
    } as never);
    await expect(authorizeNotificationDelivery('n1', 'push')).resolves.toEqual({ allowed: true });
    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain('notification.expires_at');
    expect(sql).toContain('COALESCE(delivery.next_retry_at, delivery.available_at)');
  });

  it('atomically claims a due channel as provider in flight before provider I/O', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          superseded_at: null,
          expires_at: null,
          available_at: new Date(0),
          state: 'queued',
          claimed: true,
        }],
        rowCount: 1,
      } as never);

    const claim = await claimNotificationDelivery(
      'n1',
      'push',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(claim).toMatchObject({ allowed: true });
    if (!claim.allowed) throw new Error('expected provider claim');
    expect(claim.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain('FOR UPDATE OF notification, delivery');
    expect(sql).toContain("SET state = 'provider_in_flight'");
    expect(sql).toContain("ranked.state = 'provider_in_flight'");
    expect(sql).toContain("THEN 'provider_in_flight'");
    expect(sql).toContain('provider_attempt_id = $4::UUID');
    expect(sql).toContain('provider_attempt_deadline_at = NOW() + make_interval');
    expect(sql).toContain("authority.state IN ('pending','deferred_quiet_hours','queued','retry_pending')");
    expect(params).toEqual([
      'n1',
      'push',
      new Date('2026-01-01T00:00:00.000Z'),
      claim.claimToken,
      300,
    ]);
  });

  it('uses the PostgreSQL clock as default claim authority to avoid host clock skew', async () => {
    const decisionTime = new Date('2026-01-01T00:00:00.000Z');
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          superseded_at: null,
          expires_at: null,
          available_at: decisionTime,
          decision_time: decisionTime,
          state: 'queued',
          claimed: true,
        }],
        rowCount: 1,
      } as never);

    const claim = await claimNotificationDelivery('n1', 'push');
    expect(claim).toMatchObject({ allowed: true });
    if (!claim.allowed) throw new Error('expected provider claim');

    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain('COALESCE($3::TIMESTAMPTZ,NOW()) AS decision_time');
    expect(sql).toContain('authority.available_at <= authority.decision_time');
    expect(params).toEqual(['n1', 'push', null, claim.claimToken, 300]);
  });

  it('does not claim a row superseded before the atomic authority statement', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
      rows: [{
        superseded_at: new Date(),
        expires_at: null,
        available_at: new Date(0),
        state: 'queued',
        claimed: false,
      }],
      rowCount: 1,
      } as never);
    await expect(claimNotificationDelivery('n1', 'email')).resolves.toEqual({
      allowed: false,
      reason: 'superseded',
    });
  });

  it('records provider acceptance without fabricating delivery', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationProviderAccepted('n1', 'push', 'fcm', 'batch-1', '00000000-0000-4000-8000-000000000001');
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain("state = 'provider_accepted'");
    expect(sql).toContain('provider_accepted_at = NOW()');
    expect(sql).not.toContain('delivered_at = NOW()');
    expect(sql).toContain('delivery.provider_attempt_id = $5::UUID');
    expect(sql).toContain("delivery.state IN ('provider_in_flight','provider_outcome_unknown')");
    expect(params).toEqual([
      'n1',
      'push',
      'fcm',
      'batch-1',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('records suppression as terminal for that destination without calling it delivered', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationSuppressed('n1', 'email', 'user_do_not_email', '00000000-0000-4000-8000-000000000002');
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain("state = 'suppressed'");
    expect(sql).toContain('last_error = $3');
    expect(sql).toContain('provider_attempt_id = $4::UUID');
    expect(sql).toContain("state IN ('provider_in_flight','provider_outcome_unknown')");
    expect(sql).toContain('SELECT suppressed.notification_id, suppressed.state FROM suppressed');
    expect(sql).toContain("ranked.state = 'delivered'");
    expect(params).toEqual([
      'n1',
      'email',
      'user_do_not_email',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('records channel delivery without regressing terminal channel or aggregate truth', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationDelivered('n1', 'email', 'sg-1', '00000000-0000-4000-8000-000000000003');
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain('delivery.provider_attempt_id = $4::UUID');
    expect(sql).toContain("'provider_in_flight','provider_outcome_unknown','provider_accepted'");
    expect(sql).toContain('delivered_at = COALESCE(delivered_at, NOW())');
    expect(params).toEqual([
      'n1',
      'email',
      'sg-1',
      '00000000-0000-4000-8000-000000000003',
    ]);
  });

  it('cancels only nonterminal sendable work', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationCancelled('n1', 'push', 'superseded');
    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain("state = 'cancelled_superseded'");
    expect(sql).toContain(
      "state IN ('pending','deferred_quiet_hours','queued','retry_pending')",
    );
  });

  it('bounds retries and promotes exhaustion to operator-visible terminal failure', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await markNotificationDeliveryFailure('n1', 'sms', 'provider_timeout', '00000000-0000-4000-8000-000000000004');
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain("THEN 'failed_terminal'");
    expect(sql).toContain("ELSE 'retry_pending'");
    expect(sql).toContain("terminal_visibility = 'operator_exception'");
    expect(sql).toContain('terminal_failure_at');
    expect(sql).toContain("ranked.state = 'failed_terminal'");
    expect(sql).toContain("delivery.state='failed_terminal'");
    expect(sql).toContain("delivery.next_retry_at");
    expect(sql).toContain("SET status = CASE WHEN failed.state='failed_terminal' THEN 'failed' ELSE 'pending' END");
    expect(sql).toContain('available_at = COALESCE(failed.next_retry_at');
    expect(sql).toContain('recovery_claim_id = NULL');
    expect(sql).toContain('SELECT MAX(delivery.terminal_failure_at)');
    expect(sql).toContain('terminal_failure_reason = CASE');
    expect(sql).toContain('SELECT MAX(delivery.last_error)');
    expect(sql.indexOf("ranked.state = 'delivered'")).toBeLessThan(
      sql.indexOf("ranked.state = 'failed_terminal'"),
    );
    expect(sql.indexOf("ranked.state = 'provider_accepted'")).toBeLessThan(
      sql.indexOf("ranked.state = 'failed_terminal'"),
    );
    expect(sql).toContain('delivery.provider_attempt_id = $4::UUID');
    expect(params).toEqual([
      'n1',
      'sms',
      'provider_timeout',
      '00000000-0000-4000-8000-000000000004',
      null,
      false,
    ]);
  });

  it('cannot regress accepted or terminal delivery truth on a late failure', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await markNotificationDeliveryFailure('n1', 'push', 'late_timeout');

    const [sql] = mockDb.query.mock.calls[1];
    expect(sql).toContain("'pending','deferred_quiet_hours','queued','retry_pending'");
    expect(sql).not.toContain("state IN ('provider_accepted','delivered','cancelled_superseded')");
  });

  it('records an indeterminate post-I/O result without making it retryable', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await markNotificationProviderOutcomeUnknown(
      'n1',
      'sms',
      'provider timed out after request write',
      '00000000-0000-4000-8000-000000000005',
    );

    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toContain("SET state = 'provider_outcome_unknown'");
    expect(sql).toContain('next_retry_at = NULL');
    expect(sql).toContain('delivery.provider_attempt_id = $4::UUID');
    expect(sql).toContain("delivery.state = 'provider_in_flight'");
    expect(sql).toContain('SELECT unknown.notification_id, unknown.state FROM unknown');
    expect(params).toEqual([
      'n1',
      'sms',
      'provider timed out after request write',
      '00000000-0000-4000-8000-000000000005',
    ]);
  });
});
