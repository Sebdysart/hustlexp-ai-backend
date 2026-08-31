import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  txQuery: vi.fn(),
  emailDeliver: vi.fn(),
  smsDeliver: vi.fn(),
  processed: vi.fn(),
  failed: vi.fn(),
  authorize: vi.fn(),
  claim: vi.fn(),
  cancelled: vi.fn(),
  deliveryFailed: vi.fn(),
  accepted: vi.fn(),
  outcomeUnknown: vi.fn(),
  suppressed: vi.fn(),
  notifyAdmins: vi.fn(),
  emailProviderKind: 'sendgrid' as 'sendgrid' | 'smtp_sink',
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
vi.mock('../../src/services/OutboundCommunicationService.js', () => ({
  createOutboundEmailPort: () => ({
    providerKind: mocks.emailProviderKind,
    deliver: mocks.emailDeliver,
  }),
  createOutboundSmsPort: () => ({ providerKind: 'twilio', deliver: mocks.smsDeliver }),
}));
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
vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: mocks.notifyAdmins,
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { workerLogger: log };
});

import { processEmailJob } from '../../src/jobs/email-worker.js';
import { processSMSJob } from '../../src/jobs/sms-worker.js';

const emailPayload = {
  emailId: 'email-1',
  userId: 'user-1',
  toEmail: 'worker@example.test',
  template: 'notification',
  params: {
    notificationId: 'notification-1',
    title: 'Task update',
    body: 'The task changed.',
  },
};

const emailJob = {
  id: 'email-job-1',
  data: {
    aggregate_type: 'email',
    aggregate_id: 'email-1',
    event_version: 1,
    outbox_idempotency_key: 'email.send_requested:email-1',
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000101',
    outbox_bullmq_job_id: 'email-job-1',
    payload: emailPayload,
  },
} as never;

const leadEmailPayload = {
  emailId: 'email-lead-1',
  toEmail: 'lead@example.test',
  template: 'lead_confirmation',
  params: { leadType: 'poster', firstName: 'Taylor' },
};

const leadEmailJob = {
  id: 'lead-email-job-1',
  data: {
    aggregate_type: 'lead',
    aggregate_id: 'lead-1',
    event_version: 1,
    outbox_idempotency_key: 'lead-confirm:submission-1:v1',
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000102',
    outbox_bullmq_job_id: 'lead-email-job-1',
    payload: leadEmailPayload,
  },
} as never;

const completionEmailPayload = {
  emailId: 'email-completion-1',
  userId: 'poster-1',
  toEmail: 'poster@example.test',
  template: 'universal_v1_completion_notice',
  params: {
    schemaVersion: 1,
    taskId: '10000000-0000-4000-8000-000000000001',
    workOrderId: '10000000-0000-4000-8000-000000000002',
    submittedCompletionFactId: '10000000-0000-4000-8000-000000000003',
    completionVersion: 1,
    executionVersion: 4,
    paymentCreationFrozen: true,
    hardAssignmentCreated: false,
  },
};

const completionEmailJob = {
  id: 'completion-email-job-1',
  data: {
    aggregate_type: 'email',
    aggregate_id: 'email-completion-1',
    event_version: 1,
    outbox_idempotency_key:
      'completion-notice-email:10000000-0000-4000-8000-000000000003',
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000105',
    outbox_bullmq_job_id: 'completion-email-job-1',
    payload: completionEmailPayload,
  },
} as never;

const completionSinkActorId = '10000000-0000-4000-8000-000000000005';

const smsPayload = {
  smsId: 'sms-1',
  notificationId: 'notification-1',
  userId: 'user-1',
  toPhone: '+15555550100',
  body: 'Task HX7A changed. Open HustleXP.',
};

const smsJob = {
  id: 'sms-job-1',
  data: {
    aggregate_type: 'sms',
    aggregate_id: 'sms-1',
    event_version: 1,
    outbox_idempotency_key: 'sms.send_requested:sms-1',
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000103',
    outbox_bullmq_job_id: 'sms-job-1',
    payload: smsPayload,
  },
} as never;

function emailAuthority(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email-1',
    user_id: 'user-1',
    lead_id: null,
    to_email: 'worker@example.test',
    template: 'notification',
    params_json: emailPayload.params,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    suppressed_reason: null,
    idempotency_key: 'email.send_requested:email-1',
    notification_id: 'notification-1',
    provider_msg_id: null,
    provider_name: null,
    notification_provider_attempt_id: null,
    pre_provider_claim_id: null,
    task_completion_notice_request_id: null,
    provider_receipt_at: null,
    outbox_id: 'outbox-email-1',
    outbox_event_version: 1,
    outbox_payload: emailPayload,
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000101',
    outbox_bullmq_job_id: 'email-job-1',
    ...overrides,
  };
}

function smsAuthority(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sms-1',
    user_id: 'user-1',
    to_phone: '+15555550100',
    body: 'Task HX7A changed. Open HustleXP.',
    status: 'pending',
    retry_count: 0,
    max_retries: 3,
    idempotency_key: 'sms.send_requested:sms-1',
    notification_id: 'notification-1',
    twilio_sid: null,
    provider_name: null,
    provider_message_id: null,
    notification_provider_attempt_id: null,
    pre_provider_claim_id: null,
    outbox_id: 'outbox-sms-1',
    outbox_event_version: 1,
    outbox_payload: smsPayload,
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000103',
    outbox_bullmq_job_id: 'sms-job-1',
    ...overrides,
  };
}

function completionEmailAuthority(overrides: Record<string, unknown> = {}) {
  return emailAuthority({
    id: 'email-completion-1',
    user_id: 'poster-1',
    to_email: 'poster@example.test',
    template: 'universal_v1_completion_notice',
    params_json: completionEmailPayload.params,
    idempotency_key:
      'completion-notice-email:10000000-0000-4000-8000-000000000003',
    notification_id: null,
    task_completion_notice_request_id: '10000000-0000-4000-8000-000000000004',
    outbox_payload: completionEmailPayload,
    outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000105',
    outbox_bullmq_job_id: 'completion-email-job-1',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HX_COMPLETION_DELIVERY_SINK_ACTOR_ID = completionSinkActorId;
  mocks.emailProviderKind = 'sendgrid';
  mocks.processed.mockResolvedValue(true);
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.claim.mockResolvedValue({ allowed: true, claimToken: '00000000-0000-4000-8000-000000000001' });
  mocks.transaction.mockImplementation((fn: (query: typeof mocks.txQuery) => unknown) =>
    fn(mocks.txQuery)
  );
});

describe.each([
  {
    channel: 'email',
    process: () => processEmailJob(emailJob),
    provider: mocks.emailDeliver,
  },
  {
    channel: 'sms',
    process: () => processSMSJob(smsJob),
    provider: mocks.smsDeliver,
  },
] as const)('$channel notification worker authorization', ({ channel, process, provider }) => {
  beforeEach(() => {
    mocks.query.mockResolvedValueOnce({
      rows: [channel === 'email' ? emailAuthority() : smsAuthority()],
      rowCount: 1,
    });
  });
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

    expect(mocks.failed).toHaveBeenCalledWith(
      expect.any(String),
      'notification_not_due',
      expect.objectContaining({ dispatchAttemptId: expect.any(String), bullmqJobId: expect.any(String) }),
    );
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});

it('uses one injected database for email authority and early delivery transitions', async () => {
  const injectedQuery = vi.fn().mockResolvedValue({
    rows: [emailAuthority()],
    rowCount: 1,
  });
  const injectedTransaction = vi.fn();
  const injectedDatabase = {
    query: injectedQuery,
    transaction: injectedTransaction,
  } as unknown as Database;
  mocks.authorize.mockResolvedValue({ allowed: false, reason: 'superseded' });

  await processEmailJob(emailJob, injectedDatabase);

  expect(injectedQuery).toHaveBeenCalledTimes(1);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(injectedTransaction).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith(
    'notification-1',
    'email',
    undefined,
    injectedQuery,
  );
  expect(mocks.cancelled).toHaveBeenCalledWith(
    'notification-1',
    'email',
    'superseded',
    injectedQuery,
  );
  expect(mocks.processed).toHaveBeenCalledWith(
    'email.send_requested:email-1',
    expect.objectContaining({ bullmqJobId: 'email-job-1' }),
    { query: injectedQuery },
  );
  expect(mocks.emailDeliver).not.toHaveBeenCalled();
});

describe('provider acceptance evidence', () => {
  it('refuses a live email adapter for a completion notice before provider I/O', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [completionEmailAuthority()], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key:
            'completion-notice-email:10000000-0000-4000-8000-000000000003',
          attempts: 0,
          max_attempts: 3,
          status: 'pending',
          user_id: 'poster-1',
        }],
        rowCount: 1,
      });
    mocks.txQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(processEmailJob(completionEmailJob)).resolves.toBeUndefined();

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.txQuery.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE OF email,outbox')))
      .toBe(false);
  });

  it('materializes one completion delivery fact after an exact synthetic SMTP receipt', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: '10000000-0000-4000-8000-000000000004' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'email-completion-1',
          status: 'sent',
          provider_msg_id: 'smtp-sink-completion-receipt-1',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ materialize_universal_v1_completion_notice_delivery: 'delivery-1' }],
        rowCount: 1,
      });
    mocks.emailDeliver.mockResolvedValue({
      providerKind: 'smtp_sink',
      providerMessageId: 'smtp-sink-completion-receipt-1',
      liveDelivery: false,
    });

    await processEmailJob(completionEmailJob);

    expect(mocks.emailDeliver).toHaveBeenCalledTimes(1);
    const receiptWrite = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('SET provider_msg_id = $1')
    );
    expect(receiptWrite?.[0]).toContain('provider_receipt_at');
    expect(receiptWrite?.[0]).toContain("status='provider_outcome_unknown'");
    expect(receiptWrite?.[1]?.slice(0, 2)).toEqual([
      'smtp-sink-completion-receipt-1',
      'smtp_sink',
    ]);
    expect(
      mocks.txQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('materialize_universal_v1_completion_notice_delivery')
      )
    ).toHaveLength(1);
    expect(mocks.processed).toHaveBeenCalled();
    const markerWrite = mocks.txQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SET provider_io_started_at=clock_timestamp()')
    );
    expect(markerWrite?.[0]).toContain('clock_timestamp()+make_interval');
  });

  it('materializes the same completion delivery on crash replay without a second send', async () => {
    const providerReceiptAt = '2026-08-30T12:00:00.000Z';
    mocks.query
      .mockResolvedValueOnce({
        rows: [completionEmailAuthority({
          status: 'sending',
          provider_msg_id: 'smtp-sink-crash-receipt-1',
          provider_name: 'smtp_sink',
          provider_receipt_at: providerReceiptAt,
        })],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ materialize_universal_v1_completion_notice_delivery: 'delivery-1' }],
        rowCount: 1,
      });

    await processEmailJob(completionEmailJob);

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('materialize_universal_v1_completion_notice_delivery')
      )
    ).toHaveLength(1);
    expect(mocks.processed).toHaveBeenCalled();
  });

  it('keeps a receipt discovered under the claim lock open when replay materialization fails', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    const unlockedAuthority = completionEmailAuthority();
    const lockedReceiptAuthority = completionEmailAuthority({
      status: 'sending',
      provider_msg_id: 'smtp-sink-locked-race-receipt-1',
      provider_name: 'smtp_sink',
      provider_receipt_at: '2026-08-30T12:00:00.000Z',
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [unlockedAuthority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key:
            'completion-notice-email:10000000-0000-4000-8000-000000000003',
          attempts: 1,
          max_attempts: 3,
          status: 'sending',
          user_id: 'poster-1',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [lockedReceiptAuthority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('locked replay materializer unavailable'));

    await expect(processEmailJob(completionEmailJob)).rejects.toThrow(
      'locked replay materializer unavailable'
    );

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
  });

  it('keeps a known synthetic receipt open for replay when atomic materialization fails', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key:
            'completion-notice-email:10000000-0000-4000-8000-000000000003',
          attempts: 1,
          max_attempts: 3,
          status: 'sending',
          user_id: 'poster-1',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: authority.task_completion_notice_request_id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'email-completion-1',
          status: 'sent',
          provider_msg_id: 'smtp-sink-completion-receipt-1',
        }],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error('synthetic materializer crash'));
    mocks.emailDeliver.mockResolvedValue({
      providerKind: 'smtp_sink',
      providerMessageId: 'smtp-sink-completion-receipt-1',
      liveDelivery: false,
    });

    await expect(processEmailJob(completionEmailJob)).rejects.toThrow(
      'synthetic materializer crash'
    );

    expect(mocks.emailDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET status = 'provider_outcome_unknown'")
      )
    ).toBe(false);
  });

  it('durably suppresses completion delivery when recipient or lifecycle authority drifted', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    const configuredSinkActorId = completionSinkActorId;
    process.env.HX_COMPLETION_DELIVERY_SINK_ACTOR_ID = configuredSinkActorId;
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });

    await expect(processEmailJob(completionEmailJob)).resolves.toBeUndefined();

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    const suppressionWrite = mocks.txQuery.mock.calls.find(([sql]) =>
      String(sql).includes("suppressed_reason='completion_notice_authority_revoked'")
    );
    expect(suppressionWrite?.[0]).toContain('provider_io_started_at IS NULL');
    expect(mocks.processed).toHaveBeenCalledWith(
      completionEmailJob.data.outbox_idempotency_key,
      expect.any(Object),
      expect.objectContaining({ query: mocks.txQuery }),
    );
    const authorityCheck = mocks.txQuery.mock.calls.find(([sql]) =>
      String(sql).includes('JOIN email_outbox email')
    );
    expect(authorityCheck?.[0]).toContain("task_record.automation_classification='CONTROLLED_TEST'");
    expect(authorityCheck?.[0]).toContain("task_record.universal_payment_posture='PAYMENT_CREATION_FROZEN'");
    expect(authorityCheck?.[0]).toContain('task_record.worker_id IS NULL');
    expect(authorityCheck?.[0]).toContain(
      'task_record.poster_id=notice_request.recipient_user_id'
    );
    expect(authorityCheck?.[0]).toContain(
      'task_record.active_scope_version_id=notice_request.scope_version_id'
    );
    expect(authorityCheck?.[0]).toContain("notice_outbox.status IN ('enqueued','processing')");
    expect(authorityCheck?.[0]).toContain('notice_outbox.dispatch_attempt_id=$5::UUID');
    expect(authorityCheck?.[0]).toContain('notice_outbox.bullmq_job_id=$6');
    expect(authorityCheck?.[0]).toContain('NOT EXISTS');
    expect(authorityCheck?.[0]).toContain("completion_proof.state='SUBMITTED'");
    expect(authorityCheck?.[0]).toContain('FROM task_completion_facts newer_completion');
    expect(authorityCheck?.[0]).toContain(
      'newer_completion.completion_version>notice_request.completion_version'
    );
    expect(authorityCheck?.[1]?.[3]).toBe(configuredSinkActorId);
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        String(sql).includes("hashtextextended('fulfillment:'")
      )
    ).toBe(true);
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        String(sql).includes('SET provider_io_started_at=clock_timestamp()')
      )
    ).toBe(false);
  });

  it('rolls back revoked-notice suppression when exact outbox closure loses authority', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    mocks.processed.mockResolvedValue(false);
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });

    await expect(processEmailJob(completionEmailJob)).rejects.toThrow(
      'Completion notice suppression lost exact outbox authority'
    );

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledTimes(1);
  });

  it('atomically suppresses a do-not-email completion notice with its exact outbox', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: true }], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });

    await expect(processEmailJob(completionEmailJob)).resolves.toBeUndefined();

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    const suppressionWrite = mocks.txQuery.mock.calls.find(([sql]) =>
      String(sql).includes("suppressed_reason = 'user_do_not_email'")
    );
    expect(suppressionWrite?.[0]).toContain("status='sending'");
    expect(mocks.processed).toHaveBeenCalledWith(
      completionEmailJob.data.outbox_idempotency_key,
      expect.any(Object),
      { query: mocks.txQuery },
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it('rolls back do-not-email completion suppression if exact outbox closure loses authority', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    mocks.processed.mockResolvedValue(false);
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: true }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key: authority.idempotency_key,
          attempts: 1,
          max_attempts: 3,
          status: 'sending',
          user_id: 'poster-1',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });

    await expect(processEmailJob(completionEmailJob)).rejects.toThrow(
      'Completion notice suppression lost exact outbox authority'
    );

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledTimes(1);
  });

  it('rolls back an ambiguous completion outcome if exact outbox closure loses authority', async () => {
    mocks.emailProviderKind = 'smtp_sink';
    mocks.processed.mockResolvedValue(false);
    const authority = completionEmailAuthority();
    mocks.query
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key: authority.idempotency_key,
          attempts: 1,
          max_attempts: 3,
          status: 'sending',
          user_id: 'poster-1',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [authority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-completion-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: authority.task_completion_notice_request_id }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-completion-1' }], rowCount: 1 });
    mocks.emailDeliver.mockRejectedValue(new Error('synthetic provider timeout'));

    await expect(processEmailJob(completionEmailJob)).rejects.toThrow(
      'Completion notice provider outcome lost exact outbox authority'
    );

    expect(mocks.emailDeliver).toHaveBeenCalledTimes(1);
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET status = 'provider_outcome_unknown'")
      )
    ).toBe(true);
    expect(mocks.processed).toHaveBeenCalledTimes(1);
  });

  it('accepts the canonical lead-owned envelope and reconciles a persisted receipt', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [emailAuthority({
          id: 'email-lead-1',
          user_id: null,
          lead_id: 'lead-1',
          to_email: 'lead@example.test',
          template: 'lead_confirmation',
          params_json: leadEmailPayload.params,
          idempotency_key: 'lead-confirm:submission-1:v1',
          notification_id: null,
          provider_msg_id: 'sg-lead-receipt',
          provider_name: 'sendgrid',
          outbox_payload: leadEmailPayload,
          outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000102',
          outbox_bullmq_job_id: 'lead-email-job-1',
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-lead-1' }], rowCount: 1 });

    await processEmailJob(leadEmailJob);

    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledWith(
      'lead-confirm:submission-1:v1',
      expect.objectContaining({ bullmqJobId: 'lead-email-job-1' }),
    );
  });

  it('reconciles a SendGrid receipt persisted before the acceptance callback without a second provider call', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000011';
    mocks.query
      .mockResolvedValueOnce({
        rows: [emailAuthority({
          status: 'sending',
          provider_msg_id: 'sg-crash-receipt',
          provider_name: 'sendgrid',
          notification_provider_attempt_id: providerAttemptId,
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1' }], rowCount: 1 });

    await processEmailJob(emailJob);

    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1',
      'email',
      'sendgrid',
      'sg-crash-receipt',
      providerAttemptId,
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledWith(
      'email.send_requested:email-1',
      expect.any(Object),
    );
  });

  it('reconciles a Twilio receipt persisted before the acceptance callback without a second provider call', async () => {
    const providerAttemptId = '00000000-0000-4000-8000-000000000012';
    mocks.query
      .mockResolvedValueOnce({
        rows: [smsAuthority({
          status: 'sending',
          provider_name: 'twilio',
          provider_message_id: 'SM-crash-receipt',
          notification_provider_attempt_id: providerAttemptId,
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1' }], rowCount: 1 });

    await processSMSJob(smsJob);

    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1',
      'sms',
      'twilio',
      'SM-crash-receipt',
      providerAttemptId,
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.smsDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledWith(
      'sms.send_requested:sms-1',
      expect.any(Object),
    );
  });

  it('records SendGrid acceptance without claiming mailbox delivery', async () => {
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [emailAuthority()],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'notification-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1' }], rowCount: 1 });
    mocks.query
      .mockResolvedValueOnce({
        rows: [emailAuthority()],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ do_not_email: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-1', status: 'sent', provider_msg_id: 'sg-message-1' }],
        rowCount: 1,
      });
    mocks.emailDeliver.mockResolvedValue({
      providerKind: 'sendgrid',
      providerMessageId: 'sg-message-1',
      liveDelivery: true,
    });

    await processEmailJob(emailJob);

    expect(mocks.emailDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1',
      'email',
      'sendgrid',
      'sg-message-1',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(mocks.processed).toHaveBeenCalledWith(
      'email.send_requested:email-1',
      expect.any(Object),
    );
  });

  it('records Twilio acceptance without claiming handset delivery', async () => {
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [smsAuthority()],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'sms-1', status: 'sending', retry_count: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'notification-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1' }], rowCount: 1 });
    mocks.query
      .mockResolvedValueOnce({
        rows: [smsAuthority()],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'sms-1',
            status: 'sent',
            provider_name: 'twilio',
            provider_message_id: 'SM123',
          },
        ],
        rowCount: 1,
      });
    mocks.smsDeliver.mockResolvedValue({
      providerKind: 'twilio',
      providerMessageId: 'SM123',
      liveDelivery: true,
    });

    await processSMSJob(smsJob);

    expect(mocks.smsDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(
      'notification-1',
      'sms',
      'twilio',
      'SM123',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(mocks.processed).toHaveBeenCalledWith(
      'sms.send_requested:sms-1',
      expect.any(Object),
    );
  });
});

describe('direct provider outcome authority', () => {
  it('parks an ambiguous lead email timeout with a durable non-null provider token', async () => {
    const directAuthority = emailAuthority({
      id: 'email-lead-1',
      user_id: null,
      lead_id: 'lead-1',
      to_email: 'lead@example.test',
      template: 'lead_confirmation',
      params_json: leadEmailPayload.params,
      idempotency_key: 'lead-confirm:submission-1:v1',
      notification_id: null,
      outbox_payload: leadEmailPayload,
      outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000102',
      outbox_bullmq_job_id: 'lead-email-job-1',
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [directAuthority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key: 'lead-confirm:submission-1:v1',
          attempts: 1,
          max_attempts: 3,
          status: 'sending',
          user_id: null,
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [directAuthority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-lead-1', status: 'sending', attempts: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-lead-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-lead-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'email-lead-1' }], rowCount: 1 });
    mocks.emailDeliver.mockRejectedValue(new Error('synthetic provider timeout'));

    await expect(processEmailJob(leadEmailJob)).resolves.toBeUndefined();

    const unknownCall = mocks.txQuery.mock.calls.find(([sql]) => (
      String(sql).includes("status = 'provider_outcome_unknown'")
    ));
    expect(unknownCall).toBeDefined();
    expect(unknownCall![1][2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.emailDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledWith(
      'lead-confirm:submission-1:v1',
      expect.objectContaining({ bullmqJobId: 'lead-email-job-1' }),
      { query: mocks.txQuery },
    );
  });

  it('parks an ambiguous direct SMS timeout without automatic retry', async () => {
    const directPayload = {
      smsId: 'sms-direct-1',
      userId: 'user-1',
      toPhone: '+15555550101',
      body: 'Direct synthetic SMS.',
    };
    const directJob = {
      id: 'sms-direct-job-1',
      data: {
        aggregate_type: 'sms',
        aggregate_id: 'sms-direct-1',
        event_version: 1,
        outbox_idempotency_key: 'sms.send_requested:sms-direct-1',
        outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000104',
        outbox_bullmq_job_id: 'sms-direct-job-1',
        payload: directPayload,
      },
    } as never;
    const directAuthority = smsAuthority({
      id: 'sms-direct-1',
      to_phone: '+15555550101',
      body: 'Direct synthetic SMS.',
      idempotency_key: 'sms.send_requested:sms-direct-1',
      notification_id: null,
      outbox_payload: directPayload,
      outbox_dispatch_attempt_id: '00000000-0000-4000-8000-000000000104',
      outbox_bullmq_job_id: 'sms-direct-job-1',
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [directAuthority], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key: 'sms.send_requested:sms-direct-1',
          retry_count: 1,
          max_retries: 3,
          status: 'sending',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [directAuthority], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-direct-1', status: 'sending', retry_count: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-direct-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-direct-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-direct-1' }], rowCount: 1 });
    mocks.smsDeliver.mockRejectedValue(new Error('synthetic provider timeout'));

    await expect(processSMSJob(directJob)).resolves.toBeUndefined();

    const unknownCall = mocks.txQuery.mock.calls.find(([sql]) => (
      String(sql).includes("status = 'provider_outcome_unknown'")
    ));
    expect(unknownCall).toBeDefined();
    expect(unknownCall![1][2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.smsDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.processed).toHaveBeenCalledWith(
      'sms.send_requested:sms-direct-1',
      expect.objectContaining({ bullmqJobId: 'sms-direct-job-1' }),
      { query: mocks.txQuery },
    );
  });
});

describe('bounded pre-provider claim ownership', () => {
  it('does not process or send email when another worker owns an active local lease', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [emailAuthority()], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [emailAuthority({
          status: 'sending',
          pre_provider_claim_id: '00000000-0000-4000-8000-000000000021',
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processEmailJob(emailJob);

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('does not process or send SMS when another worker owns an active local lease', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [smsAuthority()], rowCount: 1 });
    mocks.txQuery
      .mockResolvedValueOnce({
        rows: [smsAuthority({
          status: 'sending',
          pre_provider_claim_id: '00000000-0000-4000-8000-000000000022',
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processSMSJob(smsJob);

    expect(mocks.smsDeliver).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('does not let an expired email claimant suppress or process a successor claim', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [emailAuthority()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ do_not_email: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [emailAuthority()], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'email-1', status: 'sending', attempts: 1 }],
        rowCount: 1,
      });

    await processEmailJob(emailJob);

    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.suppressed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('does not let an expired SMS claimant rearm or fail a successor claim', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [smsAuthority()], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          idempotency_key: 'sms.send_requested:sms-1',
          retry_count: 1,
          max_retries: 3,
          status: 'sending',
        }],
        rowCount: 1,
      });
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [smsAuthority()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'sms-1', status: 'sending', retry_count: 1 }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('resumed after local lease expiry'))
      .mockResolvedValueOnce({ rows: [{ id: 'notification-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processSMSJob(smsJob)).resolves.toBeUndefined();

    expect(mocks.smsDeliver).not.toHaveBeenCalled();
    expect(mocks.deliveryFailed).not.toHaveBeenCalled();
    expect(mocks.outcomeUnknown).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });
});

describe('canonical PostgreSQL job authority', () => {
  it('rejects a tampered email recipient before any mutation or provider I/O', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [emailAuthority()], rowCount: 1 });
    const tamperedJob = {
      id: 'email.send_requested:email-1',
      data: {
        aggregate_type: 'email',
        aggregate_id: 'email-1',
        event_version: 1,
        payload: { ...emailPayload, toEmail: 'attacker@example.test' },
      },
    } as never;

    await expect(processEmailJob(tamperedJob)).rejects.toThrow(
      'Email job does not match canonical outbox authority',
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.emailDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('rejects a tampered SMS body before any mutation or provider I/O', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [smsAuthority()], rowCount: 1 });
    const tamperedJob = {
      id: 'sms.send_requested:sms-1',
      data: {
        aggregate_type: 'sms',
        aggregate_id: 'sms-1',
        event_version: 1,
        payload: { ...smsPayload, body: 'Injected body' },
      },
    } as never;

    await expect(processSMSJob(tamperedJob)).rejects.toThrow(
      'SMS job does not match canonical outbox authority',
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.smsDeliver).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });
});
