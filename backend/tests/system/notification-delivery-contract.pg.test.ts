import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  markNotificationDelivered,
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
} from '../../src/services/NotificationDeliveryState.js';
import { NotificationDeliveryRecoveryService } from '../../src/services/NotificationDeliveryRecoveryService.js';
import { NotificationService } from '../../src/services/NotificationService.js';

const enabled = process.env.HX_ALLOW_NOTIFICATION_PG === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup|clean|baseline)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing notification contract test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
  }
}

describePg('HX/OS PostgreSQL notification delivery contract', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const userId = randomUUID();
  const collisionUserId = randomUUID();
  const acceptedId = randomUUID();
  const retryId = randomUUID();
  const activeTaskId = randomUUID();
  const contractDedupe = `notification-pg:${runId}`;

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
    await db.query(
      `INSERT INTO users(
         id,email,full_name,default_mode,trust_tier,trust_hold
       ) VALUES
         ($1,$3,'HX Notification PG','poster',2,FALSE),
         ($2,$4,'HX Notification Collision PG','poster',2,FALSE)`,
      [
        userId,
        collisionUserId,
        `notification-${runId}@e2e.invalid`,
        `notification-collision-${runId}@e2e.invalid`,
      ],
    );
  });

  afterAll(async () => {
    await db.query("DELETE FROM outbox_events WHERE payload->>'userId'=$1", [userId]).catch(() => undefined);
    await db.query('DELETE FROM notifications WHERE user_id=$1', [userId]).catch(() => undefined);
    await db.query('DELETE FROM tasks WHERE id=$1', [activeTaskId]).catch(() => undefined);
    await db.query('DELETE FROM users WHERE id = ANY($1::UUID[])', [[userId, collisionUserId]])
      .catch(() => undefined);
  });

  it('defers P3-P5 external delivery during canonical Focus and releases it once after exit', async () => {
    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query(
        `INSERT INTO tasks(
           id,poster_id,worker_id,title,description,price,state,progress_state,accepted_at,deadline
         ) VALUES ($1,$2,$3,'Focus witness','Disposable Focus suppression witness',7500,
           'ACCEPTED','WORKING',NOW(),NOW()+INTERVAL '2 hours')`,
        [activeTaskId, collisionUserId, userId],
      );
    });

    const focusDedupe = `focus:${runId}:opportunity`;
    const deferred = await NotificationService.createNotification({
      userId,
      category: 'new_matching_task',
      title: 'Another nearby task',
      body: 'Review this after your active task.',
      deepLink: `/tasks/${runId}`,
      channels: ['push'],
      objectRef: { type: 'task_offer', id: runId },
      dedupeKey: focusDedupe,
    });
    if (!deferred.success) {
      throw new Error(`Focus notification creation failed [${deferred.error.code}]: ${deferred.error.message}`);
    }
    expect(deferred.success).toBe(true);
    expect(deferred.data).toMatchObject({
      delivery_state: 'deferred_focus',
      focus_task_id: activeTaskId,
    });

    let state = await db.query<{
      aggregate_state: string;
      channel_state: string;
      notification_available: Date;
      outbox_available: Date;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,
              notification.available_at AS notification_available,
              outbox.available_at AS outbox_available
       FROM notifications notification
       JOIN notification_deliveries delivery
         ON delivery.notification_id=notification.id AND delivery.channel='push'
       JOIN outbox_events outbox
         ON outbox.aggregate_id=notification.id
        AND outbox.event_type='push.send_requested'
       WHERE notification.id=$1`,
      [deferred.data.id],
    );
    expect(state.rows[0]).toMatchObject({
      aggregate_state: 'deferred_focus',
      channel_state: 'deferred_focus',
    });
    expect(new Date(state.rows[0].notification_available).getUTCFullYear()).toBe(9999);
    expect(new Date(state.rows[0].outbox_available).getUTCFullYear()).toBe(9999);
    await expect(NotificationDeliveryRecoveryService.releaseFocusDeferred())
      .resolves.toEqual({ released: 0 });

    const material = await NotificationService.createNotification({
      userId,
      category: 'payment_failed',
      title: 'Payment failed',
      body: 'Update the payment method for the active task.',
      deepLink: `/tasks/${activeTaskId}`,
      channels: ['in_app', 'push'],
      objectRef: { type: 'escrow', id: runId },
      dedupeKey: `focus:${runId}:payment_failed`,
    });
    if (!material.success) {
      throw new Error(`Material notification creation failed [${material.error.code}]: ${material.error.message}`);
    }
    expect(material.success).toBe(true);
    expect(material.data.focus_task_id).toBeNull();
    const materialState = await db.query<{ state: string }>(
      `SELECT state FROM notification_deliveries
       WHERE notification_id=$1 AND channel='push'`,
      [material.data.id],
    );
    expect(['pending', 'deferred_quiet_hours']).toContain(materialState.rows[0].state);
    expect(materialState.rows[0].state).not.toBe('deferred_focus');

    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query(
        `UPDATE tasks SET state='COMPLETED',progress_state='COMPLETED',completed_at=NOW()
         WHERE id=$1`,
        [activeTaskId],
      );
    });
    await expect(NotificationDeliveryRecoveryService.releaseFocusDeferred())
      .resolves.toEqual({ released: 1 });
    await expect(NotificationDeliveryRecoveryService.releaseFocusDeferred())
      .resolves.toEqual({ released: 0 });

    const releasedState = await db.query<{
      aggregate_state: string;
      channel_state: string;
      notification_available: Date;
      outbox_available: Date;
      notification_due: boolean;
      outbox_due: boolean;
    }>(
      `SELECT notification.delivery_state AS aggregate_state,
              delivery.state AS channel_state,
              notification.available_at AS notification_available,
              outbox.available_at AS outbox_available,
              notification.available_at <= NOW() AS notification_due,
              outbox.available_at <= NOW() AS outbox_due
       FROM notifications notification
       JOIN notification_deliveries delivery
         ON delivery.notification_id=notification.id AND delivery.channel='push'
       JOIN outbox_events outbox
         ON outbox.aggregate_id=notification.id
        AND outbox.event_type='push.send_requested'
       WHERE notification.id=$1`,
      [deferred.data.id],
    );
    expect(releasedState.rows[0]).toMatchObject({
      aggregate_state: 'queued',
      channel_state: 'queued',
      notification_due: true,
      outbox_due: true,
    });
  });

  it('creates one in-app delivery and returns the same row on event replay', async () => {
    const input = {
      userId,
      category: 'business_operational_digest' as const,
      title: 'Weekly operations',
      body: 'Last week: 2 completed. Now: 1 active.',
      deepLink: `/business/${runId}/operations`,
      channels: ['in_app'] as const,
      objectRef: { type: 'business_week', id: runId },
      dedupeKey: contractDedupe,
    };
    const first = await NotificationService.createNotification(input);
    const replay = await NotificationService.createNotification(input);
    if (!first.success) {
      throw new Error(`Initial notification creation failed [${first.error.code}]: ${first.error.message}`);
    }
    if (!replay.success) {
      throw new Error(`Notification replay failed [${replay.error.code}]: ${replay.error.message}`);
    }
    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect(replay.data.id).toBe(first.data.id);
    const collision = await NotificationService.createNotification({
      ...input,
      userId: collisionUserId,
    });
    expect(collision).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    const rows = await db.query<{ count: string; state: string }>(
      `SELECT COUNT(*)::TEXT AS count,MIN(delivery.state) AS state
       FROM notifications notification
       JOIN notification_deliveries delivery ON delivery.notification_id=notification.id
       WHERE notification.dedupe_key=$1`,
      [contractDedupe],
    );
    expect(rows.rows[0]).toMatchObject({ count: '1', state: 'delivered' });
  });

  it('rejects invalid class, terminal truth, duplicate dedupe, and invalid SMS state', async () => {
    const baseParams = [userId, `invalid:${runId}`, `invalid:${runId}`];
    await expect(db.query(
      `INSERT INTO notifications(
         user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key
       ) VALUES ($1,'task_completed','Invalid','Invalid','/notifications',ARRAY['in_app'],'LOW',
         'not_a_class','user',$2,$3,$3)`,
      baseParams,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(db.query(
      `INSERT INTO notifications(
         user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key,delivery_state
       ) VALUES ($1,'task_completed','Invalid','Invalid','/notifications',ARRAY['in_app'],'LOW',
         'status','user',$2,$3,$3,'failed_terminal')`,
      [userId, `terminal:${runId}`, `terminal:${runId}`],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(db.query(
      `INSERT INTO notifications(
         user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key
       ) VALUES ($1,'task_completed','Duplicate','Duplicate','/notifications',ARRAY['in_app'],'LOW',
         'status','user',$2,$3,$3)`,
      [userId, runId, contractDedupe],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(db.query(
      `INSERT INTO sms_outbox(user_id,to_phone,body,status,idempotency_key)
       VALUES ($1,$2,'Invalid','invented',$3)`,
      [userId, '+15555550123', `invalid-sms:${runId}`],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('records provider acceptance separately from delivery', async () => {
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key
       ) VALUES ($1,$2,'task_completed','Accepted','Accepted','/notifications',ARRAY['push'],'LOW',
         'status','user',$3,$4,$4)`,
      [acceptedId, userId, userId, `accepted:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(notification_id,channel,state)
       VALUES ($1,'push','queued')`,
      [acceptedId],
    );
    await markNotificationProviderAccepted(acceptedId, 'push', 'fcm', 'fcm-batch-1');
    let state = await db.query<{ state: string; delivered_at: Date | null }>(
      `SELECT state,delivered_at FROM notification_deliveries
       WHERE notification_id=$1 AND channel='push'`,
      [acceptedId],
    );
    expect(state.rows[0]).toMatchObject({ state: 'provider_accepted', delivered_at: null });
    await markNotificationDelivered(acceptedId, 'push', 'fcm-batch-1');
    state = await db.query<{ state: string; delivered_at: Date | null }>(
      `SELECT state,delivered_at FROM notification_deliveries
       WHERE notification_id=$1 AND channel='push'`,
      [acceptedId],
    );
    expect(state.rows[0].state).toBe('delivered');
    expect(state.rows[0].delivered_at).toBeInstanceOf(Date);
  });

  it('executes bounded exponential retry and preserves terminal state against late acceptance', async () => {
    await db.query(
      `INSERT INTO notifications(
         id,user_id,category,title,body,deep_link,channels,priority,notification_class,
         object_type,object_id,dedupe_key,supersession_key
       ) VALUES ($1,$2,'payout_failed','Retry','Retry','/notifications',ARRAY['sms'],'HIGH',
         'transaction_critical','user',$3,$4,$4)`,
      [retryId, userId, userId, `retry:${runId}`],
    );
    await db.query(
      `INSERT INTO notification_deliveries(notification_id,channel,state,max_attempts)
       VALUES ($1,'sms','queued',2)`,
      [retryId],
    );
    await markNotificationDeliveryFailure(retryId, 'sms', 'timeout-one');
    let state = await db.query<{
      state: string; attempt_count: number; next_retry_at: Date | null;
    }>(
      `SELECT state,attempt_count,next_retry_at FROM notification_deliveries
       WHERE notification_id=$1 AND channel='sms'`,
      [retryId],
    );
    expect(state.rows[0].state).toBe('retry_pending');
    expect(state.rows[0].attempt_count).toBe(1);
    expect(state.rows[0].next_retry_at).toBeInstanceOf(Date);

    await markNotificationDeliveryFailure(retryId, 'sms', 'timeout-two');
    state = await db.query(
      `SELECT state,attempt_count,next_retry_at FROM notification_deliveries
       WHERE notification_id=$1 AND channel='sms'`,
      [retryId],
    );
    expect(state.rows[0]).toMatchObject({ state: 'failed_terminal', attempt_count: 2, next_retry_at: null });
    await markNotificationProviderAccepted(retryId, 'sms', 'twilio', 'SM-late');
    const terminal = await db.query<{
      channel_state: string; aggregate_state: string; terminal_failure_reason: string;
    }>(
      `SELECT delivery.state AS channel_state,notification.delivery_state AS aggregate_state,
              notification.terminal_failure_reason
       FROM notification_deliveries delivery
       JOIN notifications notification ON notification.id=delivery.notification_id
       WHERE delivery.notification_id=$1 AND delivery.channel='sms'`,
      [retryId],
    );
    expect(terminal.rows[0]).toMatchObject({
      channel_state: 'failed_terminal',
      aggregate_state: 'failed_terminal',
      terminal_failure_reason: 'timeout-two',
    });
  });
});
