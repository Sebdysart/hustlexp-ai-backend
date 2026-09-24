import { db } from '../db.js';
import { logger } from '../logger.js';
import { mobileVariantsForDestination, type MobileAppVariant } from './MobilePushRouting.js';
import { businessNotificationDestinations } from './BusinessNotificationDestination.js';
import { notificationTaskId, webNotificationDestination } from './WebNotificationDestination.js';

const log = logger.child({ service: 'ExpoPushService' });
const sendEndpoint = 'https://exp.host/--/api/v2/push/send';
const receiptsEndpoint = 'https://exp.host/--/api/v2/push/getReceipts';
const channelId = 'hustlexp-default';

type Device = { id: string; expo_push_token: string; app_variant: MobileAppVariant };
type Ticket = { status: 'ok' | 'error'; id?: string; details?: { error?: string } };

async function postExpo<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`expo_http_${response.status}`);
  return response.json() as Promise<T>;
}

/** Transport and lock-screen copy contain no private task, address, or payment data. */
export async function sendExpoPushForNotification(userId: string, notificationId: string): Promise<{ sent: number; failed: number; reason?: string }> {
  const result = await db.query<{ id: string; type: string | null; category: string | null; entity_type: string | null; entity_id: string | null; action_url: string | null; deep_link: string | null; push_enabled: boolean; category_preferences: Record<string, { enabled?: boolean }> | null }>(
    `SELECT n.id, n.type, n.category, n.entity_type, n.entity_id, n.action_url, n.deep_link,
            COALESCE(p.push_enabled, TRUE) AS push_enabled, p.category_preferences
       FROM notifications n
       LEFT JOIN notification_preferences p ON p.user_id = n.user_id
      WHERE n.id = $1 AND n.user_id = $2 AND n.superseded_at IS NULL
        AND 'push' = ANY(n.channels)`,
    [notificationId, userId],
  );
  const notification = result.rows[0];
  if (!notification || !notification.push_enabled ||
      notification.category_preferences?.[notification.category ?? '']?.enabled === false) {
    return { sent: 0, failed: 0, reason: 'not_eligible' };
  }
  let destination: string | null = notification.action_url ?? notification.deep_link;
  if (notification.entity_id && (notification.entity_type === 'quote' || notification.entity_type === 'assessment') &&
      ['QUOTE_ACCEPTED', 'QUOTE_REJECTED', 'ASSESSMENT_PAID', 'ASSESSMENT_SCHEDULED', 'ASSESSMENT_REJECTED'].includes(notification.type ?? '')) {
    const resolved = await businessNotificationDestinations(db.query.bind(db),
      [{ id: notification.id, entityId: notification.entity_id, entityType: notification.entity_type }], { actorId: userId });
    destination = resolved.get(notification.id) ?? null;
  }
  const taskId = notificationTaskId(destination);
  let taskViewer: 'poster' | 'provider' | undefined;
  if (taskId) {
    const task = await db.query<{ poster_id: string; worker_id: string | null; business_member: boolean }>(
      `SELECT t.poster_id, t.worker_id, EXISTS (
         SELECT 1 FROM business_memberships m
         WHERE m.organization_id = t.business_fulfiller_organization_id
           AND m.user_id = $2 AND m.status = 'ACTIVE'
       ) AS business_member FROM tasks t WHERE t.id = $1`, [taskId, userId]);
    if (task.rows[0]?.poster_id === userId) taskViewer = 'poster';
    else if (task.rows[0]?.worker_id === userId || task.rows[0]?.business_member) taskViewer = 'provider';
  }
  const variants = mobileVariantsForDestination(webNotificationDestination(destination, taskViewer));
  if (!variants.length) return { sent: 0, failed: 0, reason: 'unsupported_destination' };

  const devices = await db.query<Device>(
    `SELECT d.id, d.expo_push_token, d.app_variant FROM mobile_push_devices d
      JOIN users u ON u.id = d.user_id
     WHERE d.user_id = $1 AND d.is_active AND d.app_variant = ANY($2::text[])
       AND u.account_status NOT IN ('DELETED', 'SUSPENDED') AND NOT COALESCE(u.is_banned, FALSE)
       AND NOT COALESCE(u.trust_hold, FALSE)`,
    [userId, variants],
  );
  log.info({ notificationId, registrations: devices.rows.length, variants }, 'expo_push_attempted');
  if (!devices.rows.length) return { sent: 0, failed: 0, reason: 'no_active_device' };

  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < devices.rows.length; offset += 100) {
    const batch = devices.rows.slice(offset, offset + 100);
    const response = await postExpo<{ data?: Ticket[]; errors?: unknown[] }>(sendEndpoint, batch.map((device) => ({
      to: device.expo_push_token,
      sound: 'default',
      channelId,
      priority: 'high',
      title: device.app_variant === 'poster' ? 'HustleXP update' : 'HustleXP Business update',
      body: 'You have a new update. Open the app for details.',
      data: { notificationId, appVariant: device.app_variant },
    })));
    if (!Array.isArray(response.data) || response.data.length !== batch.length || response.errors?.length) throw new Error('expo_unexpected_response');
    for (let index = 0; index < batch.length; index++) {
      const device = batch[index];
      const ticket = response.data[index];
      if (ticket.status === 'ok' && ticket.id) {
        sent++;
        // Expo has already accepted this message. A local receipt-write error
        // must not turn it into a retried outbox send and duplicate the alert.
        try {
          await db.query(
            `INSERT INTO mobile_push_receipts (device_id, notification_id, expo_ticket_id)
             VALUES ($1, $2, $3) ON CONFLICT (expo_ticket_id) DO NOTHING`,
            [device.id, notificationId, ticket.id],
          );
        } catch {
          log.error({ notificationId, deviceId: device.id, category: 'receipt_persistence' }, 'expo_push_receipt_write_failed');
        }
      } else {
        failed++;
        log.warn({ notificationId, deviceId: device.id, category: ticket.details?.error ?? 'unknown' }, 'expo_push_ticket_error');
        if (ticket.details?.error === 'DeviceNotRegistered') {
          await db.query(`UPDATE mobile_push_devices SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [device.id]);
          log.info({ deviceId: device.id, notificationId, reason: 'DeviceNotRegistered' }, 'expo_push_token_deactivated');
        }
      }
    }
  }
  log.info({ notificationId, sent, failed }, 'expo_push_result');
  return { sent, failed, reason: sent ? undefined : 'provider_error' };
}

/** Run periodically from the existing notification recovery loop, never inline with user mutations. */
export async function checkExpoPushReceipts(): Promise<void> {
  // Expo keeps receipts for at most 24 hours; bound local storage as well.
  await db.query(`DELETE FROM mobile_push_receipts WHERE created_at <= NOW() - INTERVAL '24 hours'`);
  const pending = await db.query<{ id: string; device_id: string; expo_ticket_id: string }>(
    `SELECT id, device_id, expo_ticket_id FROM mobile_push_receipts
     WHERE checked_at IS NULL AND created_at <= NOW() - INTERVAL '15 minutes'
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at LIMIT 100`,
  );
  if (!pending.rows.length) return;
  const response = await postExpo<{ data?: Record<string, { status: 'ok' | 'error'; details?: { error?: string } }> }>(
    receiptsEndpoint, { ids: pending.rows.map((row) => row.expo_ticket_id) },
  );
  if (!response.data) throw new Error('expo_unexpected_receipts');
  for (const row of pending.rows) {
    const receipt = response.data?.[row.expo_ticket_id];
    if (!receipt) continue;
    if (receipt.status === 'error') {
      log.warn({ deviceId: row.device_id, category: receipt.details?.error ?? 'unknown' }, 'expo_push_receipt_error');
    }
    if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
      await db.query(`UPDATE mobile_push_devices SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [row.device_id]);
      log.info({ deviceId: row.device_id, reason: 'DeviceNotRegistered' }, 'expo_push_receipt_token_deactivated');
    }
    await db.query(`UPDATE mobile_push_receipts SET checked_at = NOW() WHERE id = $1`, [row.id]);
  }
}
