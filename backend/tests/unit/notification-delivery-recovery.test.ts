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
  promoteExpiredDirectProviderClaims,
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
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // completion-notice direct claims
    .mockResolvedValueOnce({ rows: [{ promoted: '0' }], rowCount: 1 }) // direct provider claims
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // completion-notice terminal outbox
    .mockResolvedValueOnce({ rows: [{ reconciled: '0' }], rowCount: 1 }); // generic terminal outbox
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
          task_completion_notice_request_id: null,
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
      'email-1', providerAttemptId, 'receipt-email-1', 'lead:email:1', null,
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

  it('repairs a processed completion email only after atomic delivery materialization', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000204';
    const noticeRequestId = '00000000-0000-4000-8000-000000000205';
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          channel: 'email',
          channel_outbox_id: 'email-completion-repair',
          notification_id: null,
          provider_name: 'smtp_sink',
          provider_message_id: 'smtp-sink-recovery-receipt-1',
          provider_attempt_id: providerAttemptId,
          idempotency_key: 'completion-notice-email:00000000-0000-4000-8000-000000000206',
          task_completion_notice_request_id: noticeRequestId,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          channel_outbox_id: 'email-completion-repair',
          outbox_id: 'outbox-completion-repair',
          outbox_status: 'processed',
          task_completion_notice_request_id: noticeRequestId,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-repair' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ materialize_universal_v1_completion_notice_delivery: 'delivery-repaired' }],
        rowCount: 1,
      });

    await expect(reconcileNotificationProviderReceipts(10)).resolves.toBe(1);

    const [candidateSql] = mocks.query.mock.calls[0];
    expect(candidateSql).toContain('email.task_completion_notice_request_id IS NOT NULL');
    expect(candidateSql).toContain('completion_delivery.completion_notice_request_id');
    const [proofSql, proofParams] = mocks.query.mock.calls[1];
    expect(proofSql).toContain(
      'email.task_completion_notice_request_id IS NOT DISTINCT FROM $5::UUID'
    );
    expect(proofParams).toEqual([
      'email-completion-repair',
      providerAttemptId,
      'smtp-sink-recovery-receipt-1',
      'completion-notice-email:00000000-0000-4000-8000-000000000206',
      noticeRequestId,
    ]);
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'materialize_universal_v1_completion_notice_delivery'
    );
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE outbox_events'))
    ).toBe(false);
  });

  it('prioritizes completion receipts and isolates one poisoned recovery candidate', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000207';
    const noticeRequestId = '00000000-0000-4000-8000-000000000208';
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            channel: 'email',
            channel_outbox_id: 'completion-poison',
            notification_id: null,
            provider_name: 'smtp_sink',
            provider_message_id: 'smtp-sink-poison-receipt',
            provider_attempt_id: providerAttemptId,
            idempotency_key: 'completion-notice-email:00000000-0000-4000-8000-000000000209',
            task_completion_notice_request_id: noticeRequestId,
          },
          {
            channel: 'email',
            channel_outbox_id: 'lead-after-poison',
            notification_id: null,
            provider_name: 'synthetic-email',
            provider_message_id: 'lead-receipt-after-poison',
            provider_attempt_id: providerAttemptId,
            idempotency_key: 'lead:email:after-poison',
            task_completion_notice_request_id: null,
          },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [{
          channel_outbox_id: 'completion-poison',
          outbox_id: 'outbox-completion-poison',
          outbox_status: 'processed',
          task_completion_notice_request_id: noticeRequestId,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'completion-poison' }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('poisoned materializer'))
      .mockResolvedValueOnce({
        rows: [{
          channel_outbox_id: 'lead-after-poison',
          outbox_id: 'outbox-lead-after-poison',
          outbox_status: 'processing',
          task_completion_notice_request_id: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'lead-after-poison' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-lead-after-poison' }], rowCount: 1 });

    await expect(reconcileNotificationProviderReceipts(100)).resolves.toBe(1);

    expect(String(mocks.query.mock.calls[0]?.[0])).toContain(
      'ORDER BY (task_completion_notice_request_id IS NOT NULL) DESC'
    );
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'materialize_universal_v1_completion_notice_delivery'
    );
    expect(String(mocks.query.mock.calls[6]?.[0])).toContain('UPDATE outbox_events');
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

  it('orders a bound completion expiry before closing its exact outbox event', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000138';
    const injectedQuery = vi.fn();
    const injectedTransaction = vi.fn(
      async (callback: (query: typeof injectedQuery) => Promise<unknown>) => callback(injectedQuery)
    );
    injectedQuery
      .mockResolvedValueOnce({
        rows: [{
          email_id: 'completion-email-expired',
          outbox_id: 'completion-outbox-expired',
          idempotency_key: 'completion-notice-email:00000000-0000-4000-8000-000000000139',
          provider_attempt_id: providerAttemptId,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'completion-email-expired' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'completion-outbox-expired' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ promoted: '0' }], rowCount: 1 });

    await expect(
      promoteExpiredDirectProviderClaims(10, { transaction: injectedTransaction } as never)
    ).resolves.toBe(1);

    expect(injectedTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    const [candidateSql] = injectedQuery.mock.calls[0];
    expect(candidateSql).toContain('email.task_completion_notice_request_id IS NOT NULL');
    expect(candidateSql).toContain('FOR UPDATE OF email,outbox SKIP LOCKED');
    const [emailSql] = injectedQuery.mock.calls[1];
    expect(emailSql).toContain("SET status='provider_outcome_unknown'");
    const [outboxSql] = injectedQuery.mock.calls[2];
    expect(outboxSql).toContain("SET status='processed'");
    expect(outboxSql).toContain("status IN ('pending','enqueued','processing','failed')");
    const [genericSql] = injectedQuery.mock.calls[3];
    expect(genericSql).toContain('email.task_completion_notice_request_id IS NULL');
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
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ outbox_id: '00000000-0000-4000-8000-000000000301' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: '00000000-0000-4000-8000-000000000301' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ reconciled: '2' }], rowCount: 1 });

    await expect(reconcileTerminalNotificationOutboxEvents(10_000)).resolves.toBe(3);

    const [completionCandidateSql, completionCandidateParams] = mocks.query.mock.calls[0];
    expect(completionCandidateSql).toContain(
      'notice_request.id=email.task_completion_notice_request_id'
    );
    expect(completionCandidateSql).toContain(
      "outbox.status IN ('pending','enqueued','processing','failed')"
    );
    expect(completionCandidateSql).toContain("email.status='suppressed'");
    expect(completionCandidateSql).toContain("email.status='provider_outcome_unknown'");
    expect(completionCandidateSql).toContain("email.status='sent'");
    expect(completionCandidateParams).toEqual([100]);

    const [completionCloseSql, completionCloseParams] = mocks.query.mock.calls[1];
    expect(completionCloseSql).toContain("SET status='processed'");
    expect(completionCloseSql).toContain('outbox.id=$1::UUID');
    expect(completionCloseSql).not.toContain('dispatch_attempt_id');
    expect(completionCloseSql).not.toContain('bullmq_job_id');
    expect(completionCloseParams).toEqual(['00000000-0000-4000-8000-000000000301']);

    const [sql, params] = mocks.query.mock.calls[2];
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

  it('isolates a poisoned terminal completion candidate and closes the next exact pair', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          { outbox_id: '00000000-0000-4000-8000-000000000311' },
          { outbox_id: '00000000-0000-4000-8000-000000000312' },
        ],
        rowCount: 2,
      })
      .mockRejectedValueOnce(new Error('poisoned completion terminal pair'))
      .mockResolvedValueOnce({
        rows: [{ id: '00000000-0000-4000-8000-000000000312' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ reconciled: '0' }], rowCount: 1 });

    await expect(reconcileTerminalNotificationOutboxEvents(10)).resolves.toBe(1);

    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      '00000000-0000-4000-8000-000000000311',
    ]);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([
      '00000000-0000-4000-8000-000000000312',
    ]);
  });

  it('atomically leases due retry rows even when durable channel work already exists', async () => {
    mockRecoverDuePrelude();
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await NotificationDeliveryRecoveryService.recoverDue(10_000);

    const [sql, params] = mocks.query.mock.calls[9];
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
