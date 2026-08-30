import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  retryDelivery: vi.fn(),
  deliveryFailed: vi.fn(),
  accepted: vi.fn(),
  outcomeUnknown: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { retryDelivery: mocks.retryDelivery },
}));
vi.mock('../../src/services/NotificationDeliveryState.js', () => ({
  markNotificationDeliveryFailure: mocks.deliveryFailed,
  markNotificationProviderAccepted: mocks.accepted,
  markNotificationProviderOutcomeUnknown: mocks.outcomeUnknown,
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});

import {
  NotificationDeliveryRecoveryService,
  promoteExpiredNotificationProviderClaims,
  reconcileNotificationProviderReceipts,
  reconcileTerminalNotificationOutboxEvents,
} from '../../src/services/NotificationDeliveryRecoveryService.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((fn: (query: typeof mocks.query) => unknown) => fn(mocks.query));
  mocks.outcomeUnknown.mockResolvedValue(true);
});

function mockRecoverDuePrelude(): void {
  mocks.query
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // provider receipts
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pre-provider notification locks
    .mockResolvedValueOnce({ rows: [{ recovered: '0' }], rowCount: 1 }) // pre-provider recovery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // exhausted dispatch candidates
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // expired provider claims
    .mockResolvedValueOnce({ rows: [{ promoted: '0' }], rowCount: 1 }) // direct provider claims
    .mockResolvedValueOnce({ rows: [{ reconciled: '0' }], rowCount: 1 }); // terminal outbox
}

describe('notification delivery recovery authority', () => {
  it('atomically reconciles an exact lead-email provider receipt without fabricating aggregate state', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000201';
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          channel: 'email',
          channel_outbox_id: 'email-1',
          notification_id: null,
          provider_name: 'synthetic-email',
          provider_message_id: 'receipt-email-1',
          provider_attempt_id: providerAttemptId,
          idempotency_key: 'lead:email:1',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ channel_outbox_id: 'email-1', outbox_id: 'outbox-1', outbox_status: 'processing' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }], rowCount: 1 });

    await expect(reconcileNotificationProviderReceipts(5)).resolves.toBe(1);

    const [candidateSql] = mocks.query.mock.calls[0];
    expect(candidateSql).toContain("outbox.aggregate_type='lead'");
    expect(candidateSql).toContain("outbox.payload->>'emailId'=email.id::TEXT");
    expect(candidateSql).toContain('num_nonnulls(email.user_id,email.lead_id)=1');
    expect(candidateSql).toContain('outbox.dispatch_attempt_id IS NOT NULL');
    expect(candidateSql).toContain("email.status<>'sent' OR outbox.status<>'processed'");
    expect(candidateSql).toContain("WHEN email.user_id IS NULL THEN '{}'::JSONB");
    expect(candidateSql).not.toContain(
      "outbox.payload=jsonb_strip_nulls(jsonb_build_object(\n          'emailId'",
    );

    const [proofSql, proofParams] = mocks.query.mock.calls[1];
    expect(proofSql).toContain('FOR UPDATE OF email,outbox');
    expect(proofSql).toContain('email.notification_provider_attempt_id=$2::UUID');
    expect(proofSql).toContain("NULLIF(BTRIM(email.provider_msg_id),'')=$3");
    expect(proofSql).toContain("outbox.aggregate_type='lead'");
    expect(proofParams).toEqual([
      'email-1', providerAttemptId, 'receipt-email-1', 'lead:email:1',
    ]);

    const [finalizeSql] = mocks.query.mock.calls[2];
    expect(finalizeSql).toContain("SET status='sent'");
    expect(finalizeSql).toContain('notification_id IS NULL');
    const [closeSql, closeParams] = mocks.query.mock.calls[3];
    expect(closeSql).toContain("SET status='processed'");
    expect(closeSql).toContain("status<>'processed'");
    expect(closeParams).toEqual(['outbox-1', 'lead:email:1']);
    expect(mocks.accepted).not.toHaveBeenCalled();
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
  });

  it('finalizes an exact outcome-unknown direct SMS receipt over an already-processed outbox', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000203';
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          channel: 'sms',
          channel_outbox_id: 'sms-processed',
          notification_id: null,
          provider_name: 'synthetic-sms',
          provider_message_id: 'receipt-sms-processed',
          provider_attempt_id: providerAttemptId,
          idempotency_key: 'direct:sms:processed',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          channel_outbox_id: 'sms-processed',
          outbox_id: 'outbox-processed',
          outbox_status: 'processed',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-processed' }], rowCount: 1 });

    await expect(reconcileNotificationProviderReceipts(10)).resolves.toBe(1);

    const [candidateSql] = mocks.query.mock.calls[0];
    expect(candidateSql).toContain("sms.status<>'sent' OR outbox.status<>'processed'");
    const [proofSql] = mocks.query.mock.calls[1];
    expect(proofSql).toContain('outbox.status AS outbox_status');
    expect(proofSql).toContain("sms.status<>'sent' OR outbox.status<>'processed'");
    const [finalizeSql] = mocks.query.mock.calls[2];
    expect(finalizeSql).toContain("SET status='sent'");
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE outbox_events'))).toBe(false);
    expect(mocks.accepted).not.toHaveBeenCalled();
  });

  it('treats a stale direct-SMS provider attempt as a token-bound no-op', async () => {
    const staleAttemptId = '00000000-0000-4000-8000-000000000202';
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          channel: 'sms',
          channel_outbox_id: 'sms-1',
          notification_id: null,
          provider_name: 'synthetic-sms',
          provider_message_id: 'receipt-sms-1',
          provider_attempt_id: staleAttemptId,
          idempotency_key: 'direct:sms:1',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(reconcileNotificationProviderReceipts(10)).resolves.toBe(0);

    const [proofSql, proofParams] = mocks.query.mock.calls[1];
    expect(proofSql).toContain('sms.notification_provider_attempt_id=$2::UUID');
    expect(proofSql).toContain("COALESCE(\n               NULLIF(BTRIM(sms.provider_message_id),''),");
    expect(proofSql).toContain('FOR UPDATE OF sms,outbox');
    expect(proofParams).toEqual([
      'sms-1', staleAttemptId, 'receipt-sms-1', 'direct:sms:1',
    ]);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.accepted).not.toHaveBeenCalled();
  });

  it('promotes expired provider claims to non-retryable outcome-unknown work', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        notification_id: 'n1',
        channel: 'push',
        provider_attempt_id: '00000000-0000-4000-8000-000000000001',
      }],
      rowCount: 1,
    });

    await expect(promoteExpiredNotificationProviderClaims(10_000)).resolves.toBe(1);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("delivery.state='provider_in_flight'");
    expect(sql).toContain('delivery.provider_attempt_deadline_at <= NOW()');
    expect(sql).not.toContain('FOR UPDATE');
    expect(params).toEqual([100]);
    expect(mocks.outcomeUnknown).toHaveBeenCalledWith(
      'n1',
      'push',
      'provider_attempt_deadline_exceeded',
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('atomically releases Focus-deferred external work only after active execution ends', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ released: '2' }], rowCount: 1 });

    await expect(NotificationDeliveryRecoveryService.releaseFocusDeferred(10_000))
      .resolves.toEqual({ released: 2 });

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("notification.delivery_state = 'deferred_focus'");
    expect(sql).toContain('(notification.expires_at IS NULL OR notification.expires_at > NOW())');
    expect(sql).toContain("task.state = 'ACCEPTED'");
    expect(sql).toContain("task.progress_state IN ('ACCEPTED','TRAVELING','WORKING')");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("delivery.state = 'deferred_focus'");
    expect(sql).toContain("delivery.channel IN ('email','push','sms')");
    expect(sql).toContain("outbox.payload->'params'->>'notificationId'");
    expect(sql).toContain('focus_released_at = NOW()');
    expect(params).toEqual([100]);
  });

  it('closes exact notification outbox work only after non-retryable channel truth exists', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ reconciled: '3' }], rowCount: 1 });

    await expect(reconcileTerminalNotificationOutboxEvents(10_000)).resolves.toBe(3);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("outbox.event_type='push.send_requested'");
    expect(sql).toContain("outbox.aggregate_type='push'");
    expect(sql).toContain("outbox.event_type='email.send_requested'");
    expect(sql).toContain("outbox.aggregate_type='email'");
    expect(sql).toContain("outbox.event_type='sms.send_requested'");
    expect(sql).toContain("outbox.aggregate_type='sms'");
    expect(sql).toContain("'provider_outcome_unknown','provider_accepted','delivered'");
    expect(sql).not.toContain("delivery.state IN ('provider_in_flight'");
    expect(sql).toContain("SET status='processed'");
    expect(sql).toContain('FOR UPDATE OF outbox SKIP LOCKED');
    expect(params).toEqual([100]);
  });

  it('atomically leases due retry rows even when durable channel work already exists', async () => {
    mockRecoverDuePrelude();
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await NotificationDeliveryRecoveryService.recoverDue(10_000);

    const [sql, params] = mocks.query.mock.calls[7];
    expect(sql).toContain('WITH candidates AS MATERIALIZED');
    expect(sql).toContain("delivery.state = 'retry_pending'");
    expect(sql).toContain('delivery.next_retry_at <= NOW()');
    expect(sql).toContain('notification.superseded_at IS NULL');
    expect(sql).toContain('(notification.expires_at IS NULL OR notification.expires_at > NOW())');
    expect(sql).not.toContain('NOT EXISTS');
    expect(sql).not.toContain('email_outbox');
    expect(sql).not.toContain('sms_outbox');
    expect(sql).toContain('FOR UPDATE OF delivery SKIP LOCKED');
    expect(sql).toContain('UPDATE notification_deliveries delivery');
    expect(sql).toContain('SET next_retry_at = NULL');
    expect(sql).toContain('delivery.updated_at <= NOW() - make_interval');
    expect(sql).toContain('make_interval(secs => $2::INTEGER)');
    expect(params).toEqual([100, 300]);
  });

  it('requeues eligible channels and records failed attempts without aborting the batch', async () => {
    mockRecoverDuePrelude();
    mocks.query.mockResolvedValueOnce({
        rows: [
          { notification_id: 'n-email', channel: 'email', recovery_claim_id: '00000000-0000-4000-8000-000000000301' },
          { notification_id: 'n-sms', channel: 'sms', recovery_claim_id: '00000000-0000-4000-8000-000000000302' },
        ],
        rowCount: 2,
      });
    mocks.retryDelivery
      .mockResolvedValueOnce({ success: true, data: { queued: true } })
      .mockResolvedValueOnce({ success: false, error: { code: 'DB_ERROR', message: 'no phone' } });

    const result = await NotificationDeliveryRecoveryService.recoverDue(20);

    expect(mocks.retryDelivery).toHaveBeenNthCalledWith(
      1,
      'n-email',
      'email',
      '00000000-0000-4000-8000-000000000301',
    );
    expect(mocks.retryDelivery).toHaveBeenNthCalledWith(
      2,
      'n-sms',
      'sms',
      '00000000-0000-4000-8000-000000000302',
    );
    expect(mocks.deliveryFailed).toHaveBeenCalledWith(
      'n-sms',
      'sms',
      'no phone',
      null,
      undefined,
      '00000000-0000-4000-8000-000000000302',
    );
    expect(result).toEqual({ inspected: 2, recovered: 1, failed: 1, skipped: 0 });
  });

  it('treats an eligibility race as a safe skip', async () => {
    mockRecoverDuePrelude();
    mocks.query.mockResolvedValueOnce({
        rows: [{
          notification_id: 'n-push',
          channel: 'push',
          recovery_claim_id: '00000000-0000-4000-8000-000000000303',
        }],
        rowCount: 1,
      });
    mocks.retryDelivery.mockResolvedValueOnce({ success: true, data: { queued: false } });

    await expect(NotificationDeliveryRecoveryService.recoverDue(5)).resolves.toEqual({
      inspected: 1, recovered: 0, failed: 0, skipped: 1,
    });
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
  });
});
