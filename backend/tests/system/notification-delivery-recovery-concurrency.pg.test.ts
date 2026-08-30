import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  claimDueNotificationDeliveries,
  NotificationDeliveryRecoveryService,
  promoteExpiredNotificationProviderClaims,
  reconcileNotificationProviderReceipts,
  reconcileTerminalNotificationOutboxEvents,
  recoverExpiredNotificationPreProviderClaims,
} from '../../src/services/NotificationDeliveryRecoveryService.js';
import {
  authorizeNotificationDelivery,
  claimNotificationDelivery,
  markNotificationDelivered,
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
  markNotificationProviderOutcomeUnknown,
  markNotificationSuppressed,
} from '../../src/services/NotificationDeliveryState.js';
import { NotificationService } from '../../src/services/NotificationService.js';

const enabled = process.env.HX_ALLOW_NOTIFICATION_PG === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup|clean|baseline)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(
      `Refusing notification recovery concurrency test against ${parsed.hostname}/${parsed.pathname.slice(1)}`,
    );
  }
}

describePg('HX/OS PostgreSQL notification recovery concurrency', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const userId = randomUUID();
  const focusTaskId = randomUUID();
  const retryNotificationId = randomUUID();
  const backoffNotificationId = randomUUID();
  const durableRetryNotificationId = randomUUID();
  const inFlightNotificationId = randomUUID();
  const crashedNotificationId = randomUUID();
  const directReceiptLeadId = randomUUID();
  const supersessionObjectId = `provider-in-flight-${runId}`;
  const terminalFixtures = [
    { id: randomUUID(), state: 'delivered', sent: true, delivered: true, failed: false },
    { id: randomUUID(), state: 'provider_accepted', sent: true, delivered: false, failed: false },
    { id: randomUUID(), state: 'cancelled_superseded', sent: false, delivered: false, failed: false },
    { id: randomUUID(), state: 'suppressed', sent: false, delivered: false, failed: false },
    { id: randomUUID(), state: 'failed_terminal', sent: false, delivered: false, failed: true },
  ] as const;

  async function insertNotificationFixture(
    notificationId: string,
    channels: Array<'email' | 'push' | 'sms'>,
    state: string,
    suffix: string,
  ): Promise<void> {
    const key = `notification-recovery:${runId}:${suffix}`;
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state,available_at,
         focus_deferred_at
       ) VALUES ($1,$2::UUID,'task_completed','Recovery regression','Recovery regression',
         '/notifications',$3::TEXT[],'LOW','status','user',$2::UUID::TEXT,$4,$4,$5,
         CASE WHEN $5='deferred_focus' THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
         CASE WHEN $5='deferred_focus' THEN NOW()-INTERVAL '1 minute' ELSE NULL END)`,
      [notificationId, userId, channels, key, state],
    );
    await db.query(
      `INSERT INTO notification_deliveries(
         notification_id,channel,state,attempt_count,max_attempts,available_at
       )
       SELECT $1,channel,$3,0,3,
              CASE WHEN $3='deferred_focus' THEN 'infinity'::TIMESTAMPTZ ELSE NOW()-INTERVAL '1 minute' END
       FROM unnest($2::TEXT[]) AS channel`,
      [notificationId, channels, state],
    );
  }

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
    await db.query(
      `INSERT INTO users(id,email,full_name,default_mode,trust_tier,trust_hold)
       VALUES ($1,$2,'HX Notification Recovery PG','poster',2,FALSE)`,
      [userId, `notification-recovery-${runId}@e2e.invalid`],
    );
    await db.query(
      `INSERT INTO notifications(
       id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,$2,'task_completed','Retry claim','Retry claim','/notifications',
         ARRAY['push'],'LOW','status','user',$3,$4,$4,'retry_pending')`,
      [retryNotificationId, userId, userId, `recovery-claim:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(
         notification_id,channel,state,attempt_count,max_attempts,available_at,next_retry_at
       ) VALUES ($1,'push','retry_pending',1,3,NOW()-INTERVAL '1 minute',NOW()-INTERVAL '1 minute')`,
      [retryNotificationId],
    );
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,$2,'task_completed','Retry backoff','Retry backoff','/notifications',
         ARRAY['push'],'LOW','status','user',$3,$4,$4,'retry_pending')`,
      [backoffNotificationId, userId, userId, `recovery-backoff:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(
         notification_id,channel,state,attempt_count,max_attempts,available_at,next_retry_at
       ) VALUES ($1,'push','retry_pending',1,3,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour')`,
      [backoffNotificationId],
    );
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,$2,'task_completed','Durable retry','Durable retry','/notifications',
         ARRAY['push'],'LOW','status','user',$3,$4,$4,'queued')`,
      [durableRetryNotificationId, userId, userId, `durable-retry:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(
         notification_id,channel,state,attempt_count,max_attempts,available_at
       ) VALUES ($1,'push','queued',0,3,NOW()-INTERVAL '1 minute')`,
      [durableRetryNotificationId],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts
       ) VALUES ('push.send_requested','push',$1,1,$2,$3::JSONB,
         'user_notifications','enqueued',NOW()-INTERVAL '1 minute',1)`,
      [
        durableRetryNotificationId,
        `push.send_requested:task_completed:${userId}:${durableRetryNotificationId}:1`,
        JSON.stringify({
          notificationId: durableRetryNotificationId,
          userId,
          title: 'Durable retry',
          body: 'Durable retry',
          data: {
            notificationId: durableRetryNotificationId,
            category: 'task_completed',
            deepLink: '/notifications',
          },
        }),
      ],
    );
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,$2,'new_matching_task','Old opportunity','Old opportunity','/notifications',
         ARRAY['push'],'MEDIUM','action_required','task_offer',$3,$4,$5,'queued')`,
      [
        inFlightNotificationId,
        userId,
        supersessionObjectId,
        `provider-in-flight-old:${runId}`,
        `${userId}:task_offer:${supersessionObjectId}`,
      ],
    );
    await db.query(
      `INSERT INTO notification_deliveries(notification_id,channel,state,available_at)
       VALUES ($1,'push','queued',NOW()-INTERVAL '1 minute')`,
      [inFlightNotificationId],
    );
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,$2,'task_completed','Crash-window attempt','Crash-window attempt','/notifications',
         ARRAY['push'],'LOW','status','user',$3,$4,$4,'queued')`,
      [crashedNotificationId, userId, userId, `provider-crash:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(notification_id,channel,state,available_at)
       VALUES ($1,'push','queued',NOW()-INTERVAL '1 minute')`,
      [crashedNotificationId],
    );

    for (const fixture of terminalFixtures) {
      const key = `recovery-terminal:${runId}:${fixture.state}`;
      await db.query(
        `INSERT INTO notifications(
           id,user_id,category,title,body,deep_link,channels,priority,notification_class,
           object_type,object_id,dedupe_key,supersession_key,delivery_state,sent_at,delivered_at,
           terminal_failure_at,terminal_failure_reason
         ) VALUES ($1,$2,'task_completed','Terminal truth','Terminal truth','/notifications',
           ARRAY['push'],'LOW','status','user',$3,$4,$4,$5,
           CASE WHEN $6::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $7::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $8::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $8::BOOLEAN THEN 'terminal fixture' ELSE NULL END)`,
        [
          fixture.id,
          userId,
          userId,
          key,
          fixture.state,
          fixture.sent,
          fixture.delivered,
          fixture.failed,
        ],
      );
      await db.query(
        `INSERT INTO notification_deliveries(
           notification_id,channel,state,attempt_count,max_attempts,provider_accepted_at,delivered_at,
           terminal_failure_at,last_error
         ) VALUES ($1,'push',$2,1,3,
           CASE WHEN $3::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $4::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $5::BOOLEAN THEN NOW() ELSE NULL END,
           CASE WHEN $5::BOOLEAN THEN 'terminal fixture' ELSE NULL END)`,
        [fixture.id, fixture.state, fixture.sent, fixture.delivered, fixture.failed],
      );
    }
  });

  afterAll(async () => {
    await db.query(
      `DELETE FROM outbox_events
       WHERE idempotency_key LIKE $2
          OR aggregate_id IN (
         SELECT id FROM notifications WHERE user_id=$1
         UNION SELECT id FROM email_outbox WHERE user_id=$1
         UNION SELECT id FROM sms_outbox WHERE user_id=$1
       )`,
      [userId, `notification-recovery:${runId}:%`],
    ).catch(() => undefined);
    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query('DELETE FROM tasks WHERE id=$1', [focusTaskId]);
    }).catch(() => undefined);
    await db.query(
      'DELETE FROM email_outbox WHERE user_id=$1 OR lead_id=$2',
      [userId, directReceiptLeadId],
    ).catch(() => undefined);
    await db.query('DELETE FROM sms_outbox WHERE user_id=$1', [userId]).catch(() => undefined);
    await db.query('DELETE FROM leads WHERE id=$1', [directReceiptLeadId]).catch(() => undefined);
    await db.query('DELETE FROM notifications WHERE user_id=$1', [userId]).catch(() => undefined);
    await db.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
  });

  it('keeps a retry in backoff ineligible for provider authorization', async () => {
    await expect(authorizeNotificationDelivery(backoffNotificationId, 'push')).resolves.toEqual({
      allowed: false,
      reason: 'not_due',
    });
  });

  it('leases one due row once across overlapping recovery claims', async () => {
    const overlappingClaims = await Promise.all(
      Array.from({ length: 8 }, () => claimDueNotificationDeliveries(1)),
    );
    const claimed = overlappingClaims.flat();

    expect(claimed).toEqual([{
      notification_id: retryNotificationId,
      channel: 'push',
      recovery_claim_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }]);

    const lease = await db.query<{
      state: string;
      attempt_count: number;
      leased: boolean;
      fenced: boolean;
    }>(
      `SELECT state,attempt_count,
              next_retry_at IS NULL AND updated_at > NOW()-INTERVAL '1 minute' AS leased,
              recovery_claim_id IS NOT NULL AND recovery_claim_deadline_at > NOW() AS fenced
       FROM notification_deliveries
       WHERE notification_id=$1 AND channel='push'`,
      [retryNotificationId],
    );
    expect(lease.rows[0]).toEqual({
      state: 'retry_pending',
      attempt_count: 1,
      leased: true,
      fenced: true,
    });
  });

  it('durably re-arms existing outbox work for the database retry time and recovers it once due', async () => {
    await markNotificationDeliveryFailure(
      durableRetryNotificationId,
      'push',
      'synthetic provider timeout',
    );

    const scheduled = await db.query<{
      state: string;
      next_retry_at: Date;
      outbox_status: string;
      outbox_available_at: Date;
      attempts: number;
    }>(
      `SELECT delivery.state,delivery.next_retry_at,outbox.status AS outbox_status,
              outbox.available_at AS outbox_available_at,outbox.attempts
       FROM notification_deliveries delivery
       JOIN outbox_events outbox
         ON outbox.aggregate_id=delivery.notification_id
        AND outbox.event_type='push.send_requested'
       WHERE delivery.notification_id=$1 AND delivery.channel='push'`,
      [durableRetryNotificationId],
    );
    expect(scheduled.rows[0]).toMatchObject({
      state: 'retry_pending',
      outbox_status: 'pending',
      attempts: 1,
    });
    expect(scheduled.rows[0].next_retry_at).toEqual(scheduled.rows[0].outbox_available_at);
    expect(scheduled.rows[0].next_retry_at.getTime()).toBeGreaterThan(Date.now() + 50_000);

    const premature = await claimDueNotificationDeliveries(100);
    expect(premature).not.toContainEqual({
      notification_id: durableRetryNotificationId,
      channel: 'push',
    });

    await db.query(
      `UPDATE notification_deliveries
       SET next_retry_at=NOW()-INTERVAL '1 second'
       WHERE notification_id=$1 AND channel='push'`,
      [durableRetryNotificationId],
    );
    await db.query(
      `UPDATE outbox_events
       SET available_at=NOW()-INTERVAL '1 second'
       WHERE aggregate_id=$1 AND event_type='push.send_requested'`,
      [durableRetryNotificationId],
    );

    await expect(NotificationDeliveryRecoveryService.recoverDue(100)).resolves.toMatchObject({
      recovered: 1,
      failed: 0,
    });
    const recovered = await db.query<{
      channel_state: string;
      outbox_status: string;
      outbox_rows: string;
    }>(
      `SELECT delivery.state AS channel_state,MIN(outbox.status) AS outbox_status,
              COUNT(outbox.id)::TEXT AS outbox_rows
       FROM notification_deliveries delivery
       JOIN outbox_events outbox
         ON outbox.aggregate_id=delivery.notification_id
        AND outbox.event_type='push.send_requested'
       WHERE delivery.notification_id=$1 AND delivery.channel='push'
       GROUP BY delivery.state`,
      [durableRetryNotificationId],
    );
    expect(recovered.rows[0]).toEqual({
      channel_state: 'queued',
      outbox_status: 'pending',
      outbox_rows: '1',
    });
  });

  it('rearms stale pre-provider channel leases and safely parks Focus-deferred work', async () => {
    const activeNotificationId = randomUUID();
    const activeEmailId = randomUUID();
    const activeSmsId = randomUUID();
    const activeEmailClaimId = randomUUID();
    const activeSmsClaimId = randomUUID();
    const activePushClaimId = randomUUID();
    const activeEmailKey = `notification-recovery:${runId}:stale-active:email`;
    const activeSmsKey = `notification-recovery:${runId}:stale-active:sms`;
    const activePushKey = `notification-recovery:${runId}:stale-active:push`;

    await insertNotificationFixture(
      activeNotificationId,
      ['email', 'push', 'sms'],
      'queued',
      'stale-active',
    );
    await db.query(
      `INSERT INTO email_outbox(
         id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
         notification_id,pre_provider_claim_id,pre_provider_claimed_at,
         pre_provider_claim_deadline_at,provider_io_started_at
       ) VALUES ($1,$2,$3,'task_completed',$4::JSONB,$5,'sending',1,$6,$7,
         NOW()-INTERVAL '10 minutes',NOW()-INTERVAL '5 minutes',NULL)`,
      [
        activeEmailId,
        userId,
        `stale-active-${runId}@e2e.invalid`,
        JSON.stringify({ notificationId: activeNotificationId }),
        activeEmailKey,
        activeNotificationId,
        activeEmailClaimId,
      ],
    );
    await db.query(
      `INSERT INTO sms_outbox(
         id,user_id,to_phone,body,idempotency_key,status,retry_count,notification_id,
         pre_provider_claim_id,pre_provider_claimed_at,pre_provider_claim_deadline_at,
         provider_io_started_at
       ) VALUES ($1,$2,'+12065550101','Stale active SMS',$3,'sending',1,$4,$5,
         NOW()-INTERVAL '10 minutes',NOW()-INTERVAL '5 minutes',NULL)`,
      [activeSmsId, userId, activeSmsKey, activeNotificationId, activeSmsClaimId],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,pre_provider_claim_id,
         pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at
       ) VALUES
         ('email.send_requested','email',$1,1,$2,$3::JSONB,'user_notifications','processing',
          NOW()-INTERVAL '10 minutes',1,$4,NOW()-INTERVAL '10 minutes',
          NOW()-INTERVAL '5 minutes',NULL),
         ('sms.send_requested','sms',$5,1,$6,$3::JSONB,'user_notifications','processing',
          NOW()-INTERVAL '10 minutes',1,$7,NOW()-INTERVAL '10 minutes',
          NOW()-INTERVAL '5 minutes',NULL),
         ('push.send_requested','push',$8,1,$9,$3::JSONB,'user_notifications','processing',
          NOW()-INTERVAL '10 minutes',1,$10,NOW()-INTERVAL '10 minutes',
          NOW()-INTERVAL '5 minutes',NULL)`,
      [
        activeEmailId,
        activeEmailKey,
        JSON.stringify({ notificationId: activeNotificationId, userId }),
        activeEmailClaimId,
        activeSmsId,
        activeSmsKey,
        activeSmsClaimId,
        activeNotificationId,
        activePushKey,
        activePushClaimId,
      ],
    );

    await expect(recoverExpiredNotificationPreProviderClaims(100)).resolves.toBe(3);
    await expect(recoverExpiredNotificationPreProviderClaims(100)).resolves.toBe(0);

    const activeDeliveries = await db.query<{ channel: string; state: string }>(
      `SELECT channel,state FROM notification_deliveries
       WHERE notification_id=$1 ORDER BY channel`,
      [activeNotificationId],
    );
    expect(activeDeliveries.rows).toEqual([
      { channel: 'email', state: 'queued' },
      { channel: 'push', state: 'queued' },
      { channel: 'sms', state: 'queued' },
    ]);
    const activeChannels = await db.query<{
      email_status: string;
      email_attempts: number;
      email_claim_cleared: boolean;
      sms_status: string;
      sms_retries: number;
      sms_claim_cleared: boolean;
    }>(
      `SELECT email.status AS email_status,email.attempts AS email_attempts,
              email.pre_provider_claim_id IS NULL AS email_claim_cleared,
              sms.status AS sms_status,sms.retry_count AS sms_retries,
              sms.pre_provider_claim_id IS NULL AS sms_claim_cleared
       FROM email_outbox email
       CROSS JOIN sms_outbox sms
       WHERE email.id=$1 AND sms.id=$2`,
      [activeEmailId, activeSmsId],
    );
    expect(activeChannels.rows[0]).toEqual({
      email_status: 'pending',
      email_attempts: 0,
      email_claim_cleared: true,
      sms_status: 'pending',
      sms_retries: 0,
      sms_claim_cleared: true,
    });
    const activeEvents = await db.query<{ idempotency_key: string; status: string }>(
      `SELECT idempotency_key,status FROM outbox_events
       WHERE idempotency_key=ANY($1::TEXT[]) ORDER BY idempotency_key`,
      [[activeEmailKey, activeSmsKey, activePushKey]],
    );
    expect(activeEvents.rows).toEqual(
      [activeEmailKey, activeSmsKey, activePushKey]
        .sort()
        .map((idempotencyKey) => ({ idempotency_key: idempotencyKey, status: 'pending' })),
    );

    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query(
        `INSERT INTO tasks(
           id,poster_id,worker_id,title,description,price,state,progress_state,accepted_at,deadline
         ) VALUES ($1,$2,$3,'Focus recovery witness','Focus recovery witness',7500,
           'ACCEPTED','WORKING',NOW(),NOW()+INTERVAL '2 hours')`,
        [focusTaskId, userId, userId],
      );
    });

    const deferredNotificationId = randomUUID();
    const deferredEmailId = randomUUID();
    const deferredClaimId = randomUUID();
    const deferredKey = `notification-recovery:${runId}:stale-deferred:email`;
    await insertNotificationFixture(
      deferredNotificationId,
      ['email'],
      'deferred_focus',
      'stale-deferred',
    );
    await db.query(
      `UPDATE notifications SET focus_task_id=$2 WHERE id=$1`,
      [deferredNotificationId, focusTaskId],
    );
    await db.query(
      `INSERT INTO email_outbox(
         id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
         notification_id,pre_provider_claim_id,pre_provider_claimed_at,
         pre_provider_claim_deadline_at,provider_io_started_at
       ) VALUES ($1,$2,$3,'task_completed',$4::JSONB,$5,'sending',1,$6,$7,
         NOW()-INTERVAL '10 minutes',NOW()-INTERVAL '5 minutes',NULL)`,
      [
        deferredEmailId,
        userId,
        `stale-deferred-${runId}@e2e.invalid`,
        JSON.stringify({ notificationId: deferredNotificationId }),
        deferredKey,
        deferredNotificationId,
        deferredClaimId,
      ],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,pre_provider_claim_id,
         pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at
       ) VALUES ('email.send_requested','email',$1,1,$2,$3::JSONB,
         'user_notifications','processing',NOW()-INTERVAL '10 minutes',1,$4,
         NOW()-INTERVAL '10 minutes',NOW()-INTERVAL '5 minutes',NULL)`,
      [
        deferredEmailId,
        deferredKey,
        JSON.stringify({ notificationId: deferredNotificationId, userId }),
        deferredClaimId,
      ],
    );

    await expect(recoverExpiredNotificationPreProviderClaims(100)).resolves.toBe(1);
    await NotificationDeliveryRecoveryService.releaseFocusDeferred(100);
    const parked = await db.query<{
      aggregate_state: string;
      channel_state: string;
      email_status: string;
      event_status: string;
      email_parked: boolean;
      event_parked: boolean;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,email.status AS email_status,
              outbox.status AS event_status,
              email.available_at='infinity'::TIMESTAMPTZ AS email_parked,
              outbox.available_at='infinity'::TIMESTAMPTZ AS event_parked
       FROM notifications notification
       JOIN notification_deliveries delivery
         ON delivery.notification_id=notification.id AND delivery.channel='email'
       JOIN email_outbox email ON email.notification_id=notification.id
       JOIN outbox_events outbox
         ON outbox.aggregate_id=email.id
        AND outbox.event_type='email.send_requested'
        AND outbox.aggregate_type='email'
       WHERE notification.id=$1`,
      [deferredNotificationId],
    );
    expect(parked.rows[0]).toEqual({
      aggregate_state: 'deferred_focus',
      channel_state: 'deferred_focus',
      email_status: 'pending',
      event_status: 'pending',
      email_parked: true,
      event_parked: true,
    });

    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query(
        `UPDATE tasks SET state='COMPLETED',progress_state='COMPLETED',completed_at=NOW()
         WHERE id=$1`,
        [focusTaskId],
      );
    });
    await NotificationDeliveryRecoveryService.releaseFocusDeferred(100);
    const released = await db.query<{
      aggregate_state: string;
      channel_state: string;
      email_status: string;
      event_status: string;
      focus_released: boolean;
      email_due: boolean;
      event_due: boolean;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,email.status AS email_status,
              outbox.status AS event_status,
              notification.focus_released_at IS NOT NULL AS focus_released,
              email.available_at<=NOW() AS email_due,
              outbox.available_at<=NOW() AS event_due
       FROM notifications notification
       JOIN notification_deliveries delivery
         ON delivery.notification_id=notification.id AND delivery.channel='email'
       JOIN email_outbox email ON email.notification_id=notification.id
       JOIN outbox_events outbox
         ON outbox.aggregate_id=email.id
        AND outbox.event_type='email.send_requested'
        AND outbox.aggregate_type='email'
       WHERE notification.id=$1`,
      [deferredNotificationId],
    );
    expect(released.rows[0]).toEqual({
      aggregate_state: 'queued',
      channel_state: 'queued',
      email_status: 'pending',
      event_status: 'pending',
      focus_released: true,
      email_due: true,
      event_due: true,
    });
  });

  it('reconciles exact email and SMS receipts once and rejects empty provider identifiers', async () => {
    const receiptFixtures = [
      {
        channel: 'email' as const,
        notificationId: randomUUID(),
        channelOutboxId: randomUUID(),
        providerMessageId: `email-provider-${runId}`,
        idempotencyKey: `notification-recovery:${runId}:receipt:email`,
      },
      {
        channel: 'sms' as const,
        notificationId: randomUUID(),
        channelOutboxId: randomUUID(),
        providerMessageId: `sms-provider-${runId}`,
        idempotencyKey: `notification-recovery:${runId}:receipt:sms`,
      },
    ];

    for (const fixture of receiptFixtures) {
      await insertNotificationFixture(
        fixture.notificationId,
        [fixture.channel],
        'queued',
        `receipt-${fixture.channel}`,
      );
      const claim = await claimNotificationDelivery(fixture.notificationId, fixture.channel);
      expect(claim).toMatchObject({ allowed: true });
      if (!claim.allowed) throw new Error(`${fixture.channel} receipt claim unexpectedly denied`);

      if (fixture.channel === 'email') {
        await db.query(
          `INSERT INTO email_outbox(
             id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
             provider_name,provider_msg_id,notification_id,pre_provider_claim_id,
             pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at,
             notification_provider_attempt_id
           ) VALUES ($1,$2,$3,'task_completed',$4::JSONB,$5,'sending',1,
             'synthetic-email',$6,$7,$8,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',
             NOW()-INTERVAL '30 seconds',$9::UUID)`,
          [
            fixture.channelOutboxId,
            userId,
            `receipt-${runId}@e2e.invalid`,
            JSON.stringify({ notificationId: fixture.notificationId }),
            fixture.idempotencyKey,
            fixture.providerMessageId,
            fixture.notificationId,
            randomUUID(),
            claim.claimToken,
          ],
        );
      } else {
        await db.query(
          `INSERT INTO sms_outbox(
             id,user_id,to_phone,body,idempotency_key,status,retry_count,provider_name,
             provider_message_id,notification_id,pre_provider_claim_id,
             pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at,
             notification_provider_attempt_id
           ) VALUES ($1,$2,'+12065550102','Persisted receipt',$3,'sending',1,
             'synthetic-sms',$4,$5,$6,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',
             NOW()-INTERVAL '30 seconds',$7::UUID)`,
          [
            fixture.channelOutboxId,
            userId,
            fixture.idempotencyKey,
            fixture.providerMessageId,
            fixture.notificationId,
            randomUUID(),
            claim.claimToken,
          ],
        );
      }
      await db.query(
        `INSERT INTO outbox_events(
           event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
           queue_name,status,available_at,attempts,provider_io_started_at
         ) VALUES ($1,$2,$3,1,$4,$5::JSONB,'user_notifications','processing',NOW(),1,NOW())`,
        [
          `${fixture.channel}.send_requested`,
          fixture.channel,
          fixture.channelOutboxId,
          fixture.idempotencyKey,
          JSON.stringify({ notificationId: fixture.notificationId, userId }),
        ],
      );

      await expect(reconcileNotificationProviderReceipts(1)).resolves.toBe(1);
      await expect(reconcileNotificationProviderReceipts(1)).resolves.toBe(0);
      const reconciled = await db.query<{
        aggregate_state: string;
        channel_state: string;
        channel_status: string;
        event_status: string;
      }>(
        fixture.channel === 'email'
          ? `SELECT notification.delivery_state AS aggregate_state,
                    delivery.state AS channel_state,email.status AS channel_status,
                    outbox.status AS event_status
             FROM notifications notification
             JOIN notification_deliveries delivery
               ON delivery.notification_id=notification.id AND delivery.channel='email'
             JOIN email_outbox email ON email.notification_id=notification.id
             JOIN outbox_events outbox
               ON outbox.aggregate_id=email.id
              AND outbox.event_type='email.send_requested'
              AND outbox.aggregate_type='email'
             WHERE notification.id=$1`
          : `SELECT notification.delivery_state AS aggregate_state,
                    delivery.state AS channel_state,sms.status AS channel_status,
                    outbox.status AS event_status
             FROM notifications notification
             JOIN notification_deliveries delivery
               ON delivery.notification_id=notification.id AND delivery.channel='sms'
             JOIN sms_outbox sms ON sms.notification_id=notification.id
             JOIN outbox_events outbox
               ON outbox.aggregate_id=sms.id
              AND outbox.event_type='sms.send_requested'
              AND outbox.aggregate_type='sms'
             WHERE notification.id=$1`,
        [fixture.notificationId],
      );
      expect(reconciled.rows[0]).toEqual({
        aggregate_state: 'provider_accepted',
        channel_state: 'provider_accepted',
        channel_status: 'sent',
        event_status: 'processed',
      });
    }

    const emptyFixtures = [
      {
        channel: 'email' as const,
        notificationId: randomUUID(),
        channelOutboxId: randomUUID(),
        idempotencyKey: `notification-recovery:${runId}:empty-receipt:email`,
      },
      {
        channel: 'sms' as const,
        notificationId: randomUUID(),
        channelOutboxId: randomUUID(),
        idempotencyKey: `notification-recovery:${runId}:empty-receipt:sms`,
      },
    ];
    for (const fixture of emptyFixtures) {
      await insertNotificationFixture(
        fixture.notificationId,
        [fixture.channel],
        'queued',
        `empty-receipt-${fixture.channel}`,
      );
      const claim = await claimNotificationDelivery(fixture.notificationId, fixture.channel);
      expect(claim).toMatchObject({ allowed: true });
      if (!claim.allowed) throw new Error(`${fixture.channel} empty receipt claim unexpectedly denied`);
      if (fixture.channel === 'email') {
        await db.query(
          `INSERT INTO email_outbox(
             id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
             provider_name,provider_msg_id,notification_id,provider_io_started_at,
             notification_provider_attempt_id
           ) VALUES ($1,$2,$3,'task_completed',$4::JSONB,$5,'sending',1,
             'synthetic-email','',$6,NOW(),$7::UUID)`,
          [
            fixture.channelOutboxId,
            userId,
            `empty-receipt-${runId}@e2e.invalid`,
            JSON.stringify({ notificationId: fixture.notificationId }),
            fixture.idempotencyKey,
            fixture.notificationId,
            claim.claimToken,
          ],
        );
      } else {
        await db.query(
          `INSERT INTO sms_outbox(
             id,user_id,to_phone,body,idempotency_key,status,retry_count,provider_name,
             provider_message_id,twilio_sid,notification_id,provider_io_started_at,
             notification_provider_attempt_id
           ) VALUES ($1,$2,'+12065550103','Empty receipt',$3,'sending',1,
             'synthetic-sms','',NULL,$4,NOW(),$5::UUID)`,
          [
            fixture.channelOutboxId,
            userId,
            fixture.idempotencyKey,
            fixture.notificationId,
            claim.claimToken,
          ],
        );
      }
      await db.query(
        `INSERT INTO outbox_events(
           event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
           queue_name,status,available_at,attempts,provider_io_started_at
         ) VALUES ($1,$2,$3,1,$4,$5::JSONB,'user_notifications','processing',NOW(),1,NOW())`,
        [
          `${fixture.channel}.send_requested`,
          fixture.channel,
          fixture.channelOutboxId,
          fixture.idempotencyKey,
          JSON.stringify({ notificationId: fixture.notificationId, userId }),
        ],
      );
    }

    await expect(reconcileNotificationProviderReceipts(100)).resolves.toBe(0);
    const emptyStates = await db.query<{ channel: string; state: string }>(
      `SELECT channel,state FROM notification_deliveries
       WHERE notification_id=ANY($1::UUID[]) ORDER BY channel`,
      [emptyFixtures.map((fixture) => fixture.notificationId)],
    );
    expect(emptyStates.rows).toEqual([
      { channel: 'email', state: 'provider_in_flight' },
      { channel: 'sms', state: 'provider_in_flight' },
    ]);
  });

  it('atomically reconciles exact lead-owned and direct user receipts without notification aggregates', async () => {
    const leadSubmissionId = randomUUID();
    const exactReceipts = [
      {
        channel: 'email' as const,
        channelOutboxId: randomUUID(),
        owner: 'lead' as const,
        ownerId: directReceiptLeadId,
        providerName: 'synthetic-sendgrid',
        providerMessageId: `lead-email-provider-${runId}`,
        providerAttemptId: randomUUID(),
        preProviderClaimId: randomUUID(),
        idempotencyKey: `notification-recovery:${runId}:direct-receipt:lead-email`,
        aggregateType: 'lead',
        aggregateId: directReceiptLeadId,
        payload: {
          emailId: '',
          toEmail: `direct-receipt-lead-${runId}@e2e.invalid`,
          template: 'lead_confirmation',
          params: { leadType: 'poster', firstName: 'Receipt', optionalContext: null },
        },
      },
      {
        channel: 'email' as const,
        channelOutboxId: randomUUID(),
        owner: 'user' as const,
        ownerId: userId,
        providerName: 'synthetic-sendgrid',
        providerMessageId: `direct-email-provider-${runId}`,
        providerAttemptId: randomUUID(),
        preProviderClaimId: randomUUID(),
        idempotencyKey: `notification-recovery:${runId}:direct-receipt:user-email`,
        aggregateType: 'email',
        aggregateId: '',
        payload: {
          emailId: '',
          userId,
          toEmail: `direct-receipt-user-${runId}@e2e.invalid`,
          template: 'notification',
          params: { title: 'Direct receipt', body: 'Direct receipt', optionalContext: null },
        },
      },
      {
        channel: 'sms' as const,
        channelOutboxId: randomUUID(),
        owner: 'user' as const,
        ownerId: userId,
        providerName: 'synthetic-twilio',
        providerMessageId: `direct-sms-provider-${runId}`,
        providerAttemptId: randomUUID(),
        preProviderClaimId: randomUUID(),
        idempotencyKey: `notification-recovery:${runId}:direct-receipt:user-sms`,
        aggregateType: 'sms',
        aggregateId: '',
        payload: {
          smsId: '',
          userId,
          toPhone: '+12065550104',
          body: 'Direct receipt SMS',
        },
      },
    ];
    exactReceipts[0].payload.emailId = exactReceipts[0].channelOutboxId;
    exactReceipts[1].payload.emailId = exactReceipts[1].channelOutboxId;
    exactReceipts[1].aggregateId = exactReceipts[1].channelOutboxId;
    exactReceipts[2].payload.smsId = exactReceipts[2].channelOutboxId;
    exactReceipts[2].aggregateId = exactReceipts[2].channelOutboxId;

    await db.query(
      `INSERT INTO leads(id,submission_id,lead_type,email,name,source)
       VALUES ($1,$2,'poster',$3,'Direct receipt lead','required_test')`,
      [
        directReceiptLeadId,
        leadSubmissionId,
        `direct-receipt-lead-${runId}@e2e.invalid`,
      ],
    );

    for (const fixture of exactReceipts) {
      if (fixture.channel === 'email') {
        await db.query(
          `INSERT INTO email_outbox(
             id,user_id,lead_id,to_email,template,params_json,idempotency_key,status,attempts,
             provider_name,provider_msg_id,notification_id,pre_provider_claim_id,
             pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at,
             notification_provider_attempt_id
           ) VALUES ($1,$2::UUID,$3::UUID,$4,$5,$6::JSONB,$7,'sending',1,$8,$9,NULL,$10::UUID,
             NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',NOW()-INTERVAL '30 seconds',
             $11::UUID)`,
          [
            fixture.channelOutboxId,
            fixture.owner === 'user' ? fixture.ownerId : null,
            fixture.owner === 'lead' ? fixture.ownerId : null,
            fixture.payload.toEmail,
            fixture.payload.template,
            JSON.stringify(fixture.payload.params),
            fixture.idempotencyKey,
            fixture.providerName,
            fixture.providerMessageId,
            fixture.preProviderClaimId,
            fixture.providerAttemptId,
          ],
        );
      } else {
        await db.query(
          `INSERT INTO sms_outbox(
             id,user_id,to_phone,body,idempotency_key,status,retry_count,provider_name,
             provider_message_id,notification_id,pre_provider_claim_id,pre_provider_claimed_at,
             pre_provider_claim_deadline_at,provider_io_started_at,notification_provider_attempt_id
           ) VALUES ($1,$2,$3,$4,$5,'sending',1,$6,$7,NULL,$8::UUID,
             NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',NOW()-INTERVAL '30 seconds',
             $9::UUID)`,
          [
            fixture.channelOutboxId,
            fixture.ownerId,
            fixture.payload.toPhone,
            fixture.payload.body,
            fixture.idempotencyKey,
            fixture.providerName,
            fixture.providerMessageId,
            fixture.preProviderClaimId,
            fixture.providerAttemptId,
          ],
        );
      }
      await db.query(
        `INSERT INTO outbox_events(
           event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
           queue_name,status,available_at,attempts,bullmq_job_id,dispatch_attempt_id,
           dispatch_claimed_at,dispatch_deadline_at
         ) VALUES ($1,$2,$3,1,$4,$5::JSONB,'user_notifications','processing',NOW(),1,$6,$7,
           NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes')`,
        [
          `${fixture.channel}.send_requested`,
          fixture.aggregateType,
          fixture.aggregateId,
          fixture.idempotencyKey,
          JSON.stringify(fixture.payload),
          `direct-receipt:${fixture.channelOutboxId}`,
          randomUUID(),
        ],
      );
    }

    const alreadyProcessedReceipts = [exactReceipts[0], exactReceipts[2]];
    await db.query(
      `UPDATE email_outbox
       SET status='provider_outcome_unknown',last_error='preserve-processed-receipt'
       WHERE id=$1`,
      [exactReceipts[0].channelOutboxId],
    );
    await db.query(
      `UPDATE sms_outbox
       SET status='provider_outcome_unknown',error_message='preserve-processed-receipt'
       WHERE id=$1`,
      [exactReceipts[2].channelOutboxId],
    );
    await db.query(
      `UPDATE outbox_events
       SET status='processed',processed_at=NOW()-INTERVAL '2 minutes',
           error_message='preserve-processed-receipt'
       WHERE idempotency_key=ANY($1::TEXT[])`,
      [alreadyProcessedReceipts.map((fixture) => fixture.idempotencyKey)],
    );

    const malformedEnvelope = {
      channelOutboxId: randomUUID(),
      providerAttemptId: randomUUID(),
      preProviderClaimId: randomUUID(),
      idempotencyKey: `notification-recovery:${runId}:direct-receipt:malformed-email`,
      providerMessageId: `malformed-email-provider-${runId}`,
      payload: {
        emailId: '',
        userId,
        toEmail: `malformed-direct-receipt-${runId}@e2e.invalid`,
        template: 'notification',
        params: { title: 'Malformed envelope', body: 'Malformed envelope' },
      },
    };
    malformedEnvelope.payload.emailId = malformedEnvelope.channelOutboxId;
    await db.query(
      `INSERT INTO email_outbox(
         id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
         provider_name,provider_msg_id,notification_id,pre_provider_claim_id,
         pre_provider_claimed_at,pre_provider_claim_deadline_at,provider_io_started_at,
         notification_provider_attempt_id
       ) VALUES ($1,$2,$3,'notification',$4::JSONB,$5,'sending',1,'synthetic-sendgrid',$6,
         NULL,$7,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',
         NOW()-INTERVAL '30 seconds',$8)`,
      [
        malformedEnvelope.channelOutboxId,
        userId,
        malformedEnvelope.payload.toEmail,
        JSON.stringify(malformedEnvelope.payload.params),
        malformedEnvelope.idempotencyKey,
        malformedEnvelope.providerMessageId,
        malformedEnvelope.preProviderClaimId,
        malformedEnvelope.providerAttemptId,
      ],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,bullmq_job_id,dispatch_attempt_id,
         dispatch_claimed_at,dispatch_deadline_at
       ) VALUES ('email.send_requested','lead',$1,1,$2,$3::JSONB,
         'user_notifications','processing',NOW(),1,$4,$5,
         NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes')`,
      [
        malformedEnvelope.channelOutboxId,
        malformedEnvelope.idempotencyKey,
        JSON.stringify(malformedEnvelope.payload),
        `direct-receipt:${malformedEnvelope.channelOutboxId}`,
        randomUUID(),
      ],
    );

    const tokenlessSmsId = randomUUID();
    const tokenlessSmsKey = `notification-recovery:${runId}:direct-receipt:tokenless-sms`;
    const tokenlessSmsPayload = {
      smsId: tokenlessSmsId,
      userId,
      toPhone: '+12065550105',
      body: 'Tokenless direct receipt SMS',
    };
    await db.query(
      `INSERT INTO sms_outbox(
         id,user_id,to_phone,body,idempotency_key,status,retry_count,provider_name,
         provider_message_id,notification_id,pre_provider_claim_id,pre_provider_claimed_at,
         pre_provider_claim_deadline_at,provider_io_started_at,notification_provider_attempt_id
       ) VALUES ($1,$2,$3,$4,$5,'sending',1,'synthetic-twilio',$6,NULL,$7,
         NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',NOW()-INTERVAL '30 seconds',NULL)`,
      [
        tokenlessSmsId,
        userId,
        tokenlessSmsPayload.toPhone,
        tokenlessSmsPayload.body,
        tokenlessSmsKey,
        `tokenless-sms-provider-${runId}`,
        randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,bullmq_job_id,dispatch_attempt_id,
         dispatch_claimed_at,dispatch_deadline_at
       ) VALUES ('sms.send_requested','sms',$1,1,$2,$3::JSONB,
         'user_notifications','processing',NOW(),1,$4,$5,
         NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes')`,
      [
        tokenlessSmsId,
        tokenlessSmsKey,
        JSON.stringify(tokenlessSmsPayload),
        `direct-receipt:${tokenlessSmsId}`,
        randomUUID(),
      ],
    );

    await expect(reconcileNotificationProviderReceipts(100)).resolves.toBe(3);
    await expect(reconcileNotificationProviderReceipts(100)).resolves.toBe(0);

    const recovered = await db.query<{
      channel_id: string;
      channel_status: string;
      notification_id: string | null;
      provider_attempt_id: string;
      sent: boolean;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      event_status: string;
      event_error: string | null;
      dispatch_deadline_present: boolean;
      processed: boolean;
      no_notification_aggregate: boolean;
    }>(
      `SELECT email.id::TEXT AS channel_id,email.status AS channel_status,
              email.notification_id::TEXT,email.notification_provider_attempt_id::TEXT AS provider_attempt_id,
              email.sent_at IS NOT NULL AS sent,outbox.event_type,outbox.aggregate_type,
              outbox.aggregate_id::TEXT,outbox.payload,outbox.status AS event_status,
              outbox.error_message AS event_error,
              outbox.dispatch_deadline_at IS NOT NULL AS dispatch_deadline_present,
              outbox.processed_at IS NOT NULL AS processed,
              NOT EXISTS (SELECT 1 FROM notifications WHERE id=email.notification_id)
                AS no_notification_aggregate
       FROM email_outbox email
       JOIN outbox_events outbox ON outbox.idempotency_key=email.idempotency_key
       WHERE email.id=ANY($1::UUID[])
       UNION ALL
       SELECT sms.id::TEXT,sms.status,sms.notification_id::TEXT,
              sms.notification_provider_attempt_id::TEXT,sms.sent_at IS NOT NULL,
              outbox.event_type,outbox.aggregate_type,outbox.aggregate_id::TEXT,outbox.payload,
               outbox.status,outbox.error_message,
               outbox.dispatch_deadline_at IS NOT NULL,outbox.processed_at IS NOT NULL,
              NOT EXISTS (SELECT 1 FROM notifications WHERE id=sms.notification_id)
       FROM sms_outbox sms
       JOIN outbox_events outbox ON outbox.idempotency_key=sms.idempotency_key
       WHERE sms.id=ANY($2::UUID[])`,
      [
        exactReceipts
          .filter((fixture) => fixture.channel === 'email')
          .map((fixture) => fixture.channelOutboxId),
        exactReceipts
          .filter((fixture) => fixture.channel === 'sms')
          .map((fixture) => fixture.channelOutboxId),
      ],
    );
    expect(recovered.rows).toHaveLength(3);
    for (const fixture of exactReceipts) {
      expect(recovered.rows.find((row) => row.channel_id === fixture.channelOutboxId)).toEqual({
        channel_id: fixture.channelOutboxId,
        channel_status: 'sent',
        notification_id: null,
        provider_attempt_id: fixture.providerAttemptId,
        sent: true,
        event_type: `${fixture.channel}.send_requested`,
        aggregate_type: fixture.aggregateType,
        aggregate_id: fixture.aggregateId,
        payload: fixture.payload,
        event_status: 'processed',
        event_error: alreadyProcessedReceipts.includes(fixture)
          ? 'preserve-processed-receipt'
          : null,
        dispatch_deadline_present: alreadyProcessedReceipts.includes(fixture),
        processed: true,
        no_notification_aggregate: true,
      });
    }

    const rejected = await db.query<{
      channel_id: string;
      channel_status: string;
      sent: boolean;
      provider_attempt_id: string | null;
      event_status: string;
      processed: boolean;
    }>(
      `SELECT email.id::TEXT AS channel_id,email.status AS channel_status,
              email.sent_at IS NOT NULL AS sent,
              email.notification_provider_attempt_id::TEXT AS provider_attempt_id,
              outbox.status AS event_status,outbox.processed_at IS NOT NULL AS processed
       FROM email_outbox email
       JOIN outbox_events outbox ON outbox.idempotency_key=email.idempotency_key
       WHERE email.id=$1
       UNION ALL
       SELECT sms.id::TEXT,sms.status,sms.sent_at IS NOT NULL,
              sms.notification_provider_attempt_id::TEXT,outbox.status,
              outbox.processed_at IS NOT NULL
       FROM sms_outbox sms
       JOIN outbox_events outbox ON outbox.idempotency_key=sms.idempotency_key
       WHERE sms.id=$2`,
      [malformedEnvelope.channelOutboxId, tokenlessSmsId],
    );
    expect(rejected.rows).toEqual(expect.arrayContaining([
      {
        channel_id: malformedEnvelope.channelOutboxId,
        channel_status: 'sending',
        sent: false,
        provider_attempt_id: malformedEnvelope.providerAttemptId,
        event_status: 'processing',
        processed: false,
      },
      {
        channel_id: tokenlessSmsId,
        channel_status: 'sending',
        sent: false,
        provider_attempt_id: null,
        event_status: 'processing',
        processed: false,
      },
    ]));
  });

  it('keeps the strongest multi-channel truth under concurrent callbacks and sibling retry', async () => {
    const deliveredNotificationId = randomUUID();
    await insertNotificationFixture(
      deliveredNotificationId,
      ['email', 'push'],
      'queued',
      'concurrent-delivered-accepted',
    );
    const emailClaim = await claimNotificationDelivery(deliveredNotificationId, 'email');
    const pushClaim = await claimNotificationDelivery(deliveredNotificationId, 'push');
    expect(emailClaim).toMatchObject({ allowed: true });
    expect(pushClaim).toMatchObject({ allowed: true });
    if (!emailClaim.allowed || !pushClaim.allowed) {
      throw new Error('Concurrent delivered/accepted claims unexpectedly denied');
    }

    await Promise.all([
      markNotificationDelivered(
        deliveredNotificationId,
        'email',
        `delivered-email-${runId}`,
        emailClaim.claimToken,
      ),
      markNotificationProviderAccepted(
        deliveredNotificationId,
        'push',
        'synthetic-push',
        `accepted-push-${runId}`,
        pushClaim.claimToken,
      ),
    ]);
    const deliveredStates = await db.query<{
      aggregate_state: string;
      email_state: string;
      push_state: string;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='email') AS email_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='push') AS push_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1
       GROUP BY notification.id`,
      [deliveredNotificationId],
    );
    expect(deliveredStates.rows[0]).toEqual({
      aggregate_state: 'delivered',
      email_state: 'delivered',
      push_state: 'provider_accepted',
    });

    const unknownNotificationId = randomUUID();
    await insertNotificationFixture(
      unknownNotificationId,
      ['email', 'push'],
      'queued',
      'concurrent-unknown-retry',
    );
    const unknownEmailClaim = await claimNotificationDelivery(unknownNotificationId, 'email');
    const retryPushClaim = await claimNotificationDelivery(unknownNotificationId, 'push');
    expect(unknownEmailClaim).toMatchObject({ allowed: true });
    expect(retryPushClaim).toMatchObject({ allowed: true });
    if (!unknownEmailClaim.allowed || !retryPushClaim.allowed) {
      throw new Error('Concurrent unknown/retry claims unexpectedly denied');
    }

    await Promise.all([
      markNotificationProviderOutcomeUnknown(
        unknownNotificationId,
        'email',
        'synthetic ambiguous provider outcome',
        unknownEmailClaim.claimToken,
      ),
      markNotificationDeliveryFailure(
        unknownNotificationId,
        'push',
        'synthetic definitive provider failure',
        retryPushClaim.claimToken,
      ),
    ]);
    const unknownStates = await db.query<{
      aggregate_state: string;
      email_state: string;
      push_state: string;
      push_attempts: number;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='email') AS email_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='push') AS push_state,
              MAX(delivery.attempt_count) FILTER (WHERE delivery.channel='push') AS push_attempts
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1
       GROUP BY notification.id`,
      [unknownNotificationId],
    );
    expect(unknownStates.rows[0]).toEqual({
      aggregate_state: 'provider_outcome_unknown',
      email_state: 'provider_outcome_unknown',
      push_state: 'retry_pending',
      push_attempts: 1,
    });

    await db.query(
      `UPDATE notification_deliveries
       SET next_retry_at=NOW()-INTERVAL '1 second'
       WHERE notification_id=$1 AND channel='push'`,
      [unknownNotificationId],
    );
    const due = await claimDueNotificationDeliveries(100);
    const pushRecovery = due.find((candidate) => (
      candidate.notification_id === unknownNotificationId && candidate.channel === 'push'
    ));
    expect(pushRecovery).toEqual(expect.objectContaining({
      notification_id: unknownNotificationId,
      channel: 'push',
      recovery_claim_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    await expect(NotificationService.retryDelivery(
      unknownNotificationId,
      'push',
      pushRecovery!.recovery_claim_id,
    ))
      .resolves.toEqual({ success: true, data: { queued: true } });

    const afterRetry = await db.query<{
      aggregate_state: string;
      email_state: string;
      push_state: string;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='email') AS email_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='push') AS push_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1
       GROUP BY notification.id`,
      [unknownNotificationId],
    );
    expect(afterRetry.rows[0]).toEqual({
      aggregate_state: 'provider_outcome_unknown',
      email_state: 'provider_outcome_unknown',
      push_state: 'queued',
    });
  });

  it('rearms only the failed channel and its exact immutable event', async () => {
    const notificationId = randomUUID();
    const emailId = randomUUID();
    const smsId = randomUUID();
    const emailPreProviderClaim = randomUUID();
    const smsPreProviderClaim = randomUUID();
    const emailKey = `notification-recovery:${runId}:isolation:email`;
    const smsKey = `notification-recovery:${runId}:isolation:sms`;
    const wrongScopeKey = `notification-recovery:${runId}:isolation:wrong-scope`;

    await insertNotificationFixture(
      notificationId,
      ['email', 'sms'],
      'queued',
      'channel-failure-isolation',
    );
    const claim = await claimNotificationDelivery(notificationId, 'email');
    expect(claim).toMatchObject({ allowed: true });
    if (!claim.allowed) throw new Error('Email failure-isolation claim unexpectedly denied');

    await db.query(
      `INSERT INTO email_outbox(
         id,user_id,to_email,template,params_json,idempotency_key,status,attempts,
         notification_id,pre_provider_claim_id,pre_provider_claimed_at,
         pre_provider_claim_deadline_at,provider_io_started_at,
         notification_provider_attempt_id
       ) VALUES ($1,$2,$3,'task_completed',$4::JSONB,$5,'sending',1,$6,$7,
         NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',NOW(),$8::UUID)`,
      [
        emailId,
        userId,
        `isolation-${runId}@e2e.invalid`,
        JSON.stringify({ notificationId }),
        emailKey,
        notificationId,
        emailPreProviderClaim,
        claim.claimToken,
      ],
    );
    await db.query(
      `INSERT INTO sms_outbox(
         id,user_id,to_phone,body,idempotency_key,status,retry_count,notification_id,
         pre_provider_claim_id,pre_provider_claimed_at,pre_provider_claim_deadline_at,
         provider_io_started_at
       ) VALUES ($1,$2,'+12065550104','Failure isolation',$3,'sending',1,$4,$5,
         NOW()-INTERVAL '1 minute',NOW()+INTERVAL '4 minutes',NULL)`,
      [smsId, userId, smsKey, notificationId, smsPreProviderClaim],
    );
    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,provider_io_started_at
       ) VALUES
         ('email.send_requested','email',$1,1,$2,$3::JSONB,
          'user_notifications','processing',NOW(),1,NOW()),
         ('sms.send_requested','sms',$4,1,$5,$3::JSONB,
          'user_notifications','processing',NOW(),1,NULL),
         ('email.send_requested','sms',$1,1,$6,$3::JSONB,
          'user_notifications','processing',NOW(),1,NOW())`,
      [
        emailId,
        emailKey,
        JSON.stringify({ notificationId, userId }),
        smsId,
        smsKey,
        wrongScopeKey,
      ],
    );

    await markNotificationDeliveryFailure(
      notificationId,
      'email',
      'synthetic isolated email failure',
      claim.claimToken,
    );

    const channelStates = await db.query<{
      aggregate_state: string;
      email_state: string;
      sms_state: string;
      email_status: string;
      sms_status: string;
      email_claim_cleared: boolean;
      sms_claim_preserved: boolean;
      retry_matches_email: boolean;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='email') AS email_state,
              MAX(delivery.state) FILTER (WHERE delivery.channel='sms') AS sms_state,
              email.status AS email_status,sms.status AS sms_status,
              email.pre_provider_claim_id IS NULL AS email_claim_cleared,
              sms.pre_provider_claim_id=$4::UUID AS sms_claim_preserved,
              email.available_at=(
                SELECT next_retry_at FROM notification_deliveries
                WHERE notification_id=$1 AND channel='email'
              ) AS retry_matches_email
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       JOIN email_outbox email ON email.notification_id=notification.id
       JOIN sms_outbox sms ON sms.notification_id=notification.id
       WHERE notification.id=$1 AND email.id=$2 AND sms.id=$3
       GROUP BY notification.id,email.id,sms.id`,
      [notificationId, emailId, smsId, smsPreProviderClaim],
    );
    expect(channelStates.rows[0]).toEqual({
      aggregate_state: 'retry_pending',
      email_state: 'retry_pending',
      sms_state: 'queued',
      email_status: 'pending',
      sms_status: 'sending',
      email_claim_cleared: true,
      sms_claim_preserved: true,
      retry_matches_email: true,
    });
    const events = await db.query<{ idempotency_key: string; status: string }>(
      `SELECT idempotency_key,status FROM outbox_events
       WHERE idempotency_key=ANY($1::TEXT[]) ORDER BY idempotency_key`,
      [[emailKey, smsKey, wrongScopeKey]],
    );
    expect(events.rows).toEqual(
      [
        { idempotency_key: emailKey, status: 'pending' },
        { idempotency_key: smsKey, status: 'processing' },
        { idempotency_key: wrongScopeKey, status: 'processing' },
      ].sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key)),
    );
  });

  it('preserves an actual provider call across supersession using a post-claim barrier', async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let reportClaimed!: () => void;
    const providerClaimed = new Promise<void>((resolve) => {
      reportClaimed = resolve;
    });

    const providerAttempt = (async () => {
      const claim = await claimNotificationDelivery(inFlightNotificationId, 'push');
      expect(claim).toMatchObject({ allowed: true });
      if (!claim.allowed) throw new Error('provider claim unexpectedly denied');
      reportClaimed();
      await providerReleased;
      await markNotificationProviderAccepted(
        inFlightNotificationId,
        'push',
        'synthetic-push',
        'synthetic-provider-message-1',
        claim.claimToken,
      );
    })();

    await providerClaimed;
    const claimed = await db.query<{ aggregate_state: string; channel_state: string }>(
      `SELECT notification.delivery_state AS aggregate_state,delivery.state AS channel_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [inFlightNotificationId],
    );
    expect(claimed.rows[0]).toEqual({
      aggregate_state: 'provider_in_flight',
      channel_state: 'provider_in_flight',
    });

    const successor = await NotificationService.createNotification({
      userId,
      category: 'task_accepted',
      title: 'Opportunity no longer current',
      body: 'The task has moved to the next lifecycle state.',
      deepLink: `/notifications/${runId}/successor`,
      channels: ['in_app'],
      objectRef: { type: 'task_offer', id: supersessionObjectId },
      dedupeKey: `provider-in-flight-successor:${runId}`,
    });
    expect(successor.success).toBe(true);

    const whileBlocked = await db.query<{
      superseded: boolean;
      aggregate_state: string;
      channel_state: string;
    }>(
      `SELECT notification.superseded_at IS NOT NULL AS superseded,
              notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [inFlightNotificationId],
    );
    expect(whileBlocked.rows[0]).toEqual({
      superseded: true,
      aggregate_state: 'provider_in_flight',
      channel_state: 'provider_in_flight',
    });

    releaseProvider();
    await providerAttempt;

    const accepted = await db.query<{ aggregate_state: string; channel_state: string }>(
      `SELECT notification.delivery_state AS aggregate_state,delivery.state AS channel_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [inFlightNotificationId],
    );
    expect(accepted.rows[0]).toEqual({
      aggregate_state: 'provider_accepted',
      channel_state: 'provider_accepted',
    });
  });

  it('converts a crashed provider claim to explicit outcome-unknown and only reconciles its exact token', async () => {
    const claim = await claimNotificationDelivery(crashedNotificationId, 'push');
    expect(claim).toMatchObject({ allowed: true });
    if (!claim.allowed) throw new Error('provider claim unexpectedly denied');

    await markNotificationProviderAccepted(
      crashedNotificationId,
      'push',
      'synthetic-push',
      'stale-provider-message',
      randomUUID(),
    );
    await db.query(
      `UPDATE notification_deliveries
       SET provider_attempt_started_at=NOW()-INTERVAL '10 minutes',
           provider_attempt_deadline_at=NOW()-INTERVAL '5 minutes'
       WHERE notification_id=$1 AND channel='push'`,
      [crashedNotificationId],
    );

    await expect(promoteExpiredNotificationProviderClaims(100)).resolves.toBeGreaterThanOrEqual(1);

    const unknown = await db.query<{
      aggregate_state: string;
      channel_state: string;
      provider_attempt_id: string;
      next_retry_at: Date | null;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,delivery.state AS channel_state,
              delivery.provider_attempt_id::TEXT,delivery.next_retry_at
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [crashedNotificationId],
    );
    expect(unknown.rows[0]).toEqual({
      aggregate_state: 'provider_outcome_unknown',
      channel_state: 'provider_outcome_unknown',
      provider_attempt_id: claim.claimToken,
      next_retry_at: null,
    });
    await expect(authorizeNotificationDelivery(crashedNotificationId, 'push')).resolves.toEqual({
      allowed: false,
      reason: 'provider_outcome_unknown',
    });
    const retryClaims = await claimDueNotificationDeliveries(100);
    expect(retryClaims).not.toContainEqual({
      notification_id: crashedNotificationId,
      channel: 'push',
    });

    await markNotificationProviderAccepted(
      crashedNotificationId,
      'push',
      'synthetic-push',
      'reconciled-provider-message',
      claim.claimToken,
    );
    const reconciled = await db.query<{ aggregate_state: string; channel_state: string }>(
      `SELECT notification.delivery_state AS aggregate_state,delivery.state AS channel_state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [crashedNotificationId],
    );
    expect(reconciled.rows[0]).toEqual({
      aggregate_state: 'provider_accepted',
      channel_state: 'provider_accepted',
    });
  });

  it('closes stranded immutable outbox work only after provider truth becomes terminal', async () => {
    const notificationId = randomUUID();
    const eventKey = `notification-recovery:${runId}:terminal-outbox:push`;
    await insertNotificationFixture(notificationId, ['push'], 'queued', 'terminal-outbox');
    const claim = await claimNotificationDelivery(notificationId, 'push');
    expect(claim).toMatchObject({ allowed: true });
    if (!claim.allowed) throw new Error('Terminal-outbox provider claim unexpectedly denied');

    await db.query(
      `INSERT INTO outbox_events(
         event_type,aggregate_type,aggregate_id,event_version,idempotency_key,payload,
         queue_name,status,available_at,attempts,provider_io_started_at
       ) VALUES ('push.send_requested','push',$1,1,$2,$3::JSONB,
         'user_notifications','processing',NOW(),1,NOW())`,
      [
        notificationId,
        eventKey,
        JSON.stringify({ notificationId, userId }),
      ],
    );

    await expect(reconcileTerminalNotificationOutboxEvents(100)).resolves.toBe(0);
    const stillInFlight = await db.query<{ state: string; status: string }>(
      `SELECT delivery.state,outbox.status
       FROM notification_deliveries delivery
       JOIN outbox_events outbox
         ON outbox.aggregate_id=delivery.notification_id
        AND outbox.event_type='push.send_requested'
        AND outbox.aggregate_type='push'
       WHERE delivery.notification_id=$1 AND delivery.channel='push'`,
      [notificationId],
    );
    expect(stillInFlight.rows[0]).toEqual({
      state: 'provider_in_flight',
      status: 'processing',
    });

    await markNotificationProviderAccepted(
      notificationId,
      'push',
      'synthetic-push',
      `terminal-outbox-provider-${runId}`,
      claim.claimToken,
    );
    await expect(reconcileTerminalNotificationOutboxEvents(100)).resolves.toBe(1);
    await expect(reconcileTerminalNotificationOutboxEvents(100)).resolves.toBe(0);

    const closed = await db.query<{
      aggregate_state: string;
      channel_state: string;
      event_status: string;
      processed: boolean;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,outbox.status AS event_status,
              outbox.processed_at IS NOT NULL AS processed
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       JOIN outbox_events outbox
         ON outbox.aggregate_id=notification.id
        AND outbox.event_type='push.send_requested'
        AND outbox.aggregate_type='push'
       WHERE notification.id=$1 AND delivery.channel='push'`,
      [notificationId],
    );
    expect(closed.rows[0]).toEqual({
      aggregate_state: 'provider_accepted',
      channel_state: 'provider_accepted',
      event_status: 'processed',
      processed: true,
    });
  });

  it('does not regress terminal truth on late failure, delivery, or suppression', async () => {
    await Promise.all(
      terminalFixtures.map((fixture) => (
        markNotificationDeliveryFailure(fixture.id, 'push', 'late provider timeout')
      )),
    );
    await Promise.all(
      terminalFixtures
        .filter((fixture) => fixture.state !== 'provider_accepted')
        .map((fixture) => markNotificationDelivered(fixture.id, 'push', 'late-provider-id')),
    );
    await Promise.all(
      terminalFixtures.map((fixture) => (
        markNotificationSuppressed(fixture.id, 'push', 'late suppression')
      )),
    );

    const states = await db.query<{
      id: string;
      aggregate_state: string;
      channel_state: string;
      attempt_count: number;
      last_error: string | null;
    }>(
      `SELECT notification.id,notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,delivery.attempt_count,delivery.last_error
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.id=ANY($1::UUID[])
       ORDER BY delivery.state`,
      [terminalFixtures.map((fixture) => fixture.id)],
    );
    expect(states.rows).toEqual(
      terminalFixtures
        .map((fixture) => ({
          id: fixture.id,
          aggregate_state: fixture.state,
          channel_state: fixture.state,
          attempt_count: 1,
          last_error: fixture.failed ? 'terminal fixture' : null,
        }))
        .sort((left, right) => left.channel_state.localeCompare(right.channel_state)),
    );
  });
});
