/**
 * AdminNotificationHelper v1.0.0
 *
 * Shared utility to fetch admin user IDs from admin_roles and broadcast
 * admin-only notifications (fraud alerts, moderation escalations, etc.).
 *
 * Admin notifications bypass the task-participation check in NotificationService
 * by NOT including a taskId. They use 'security_alert' category which bypasses
 * quiet hours (DND_BYPASS_CATEGORIES).
 *
 * @see admin_roles table (user_id, role)
 * @see NotificationService.createNotification
 */

import { db } from '../db';
import { NotificationService, type NotificationPriority } from './NotificationService';

// Cache admin IDs for 5 minutes to avoid repeated DB lookups during burst events
let cachedAdminIds: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all admin user IDs from the admin_roles table.
 * Includes roles: admin, founder, moderator (NOT support — they don't get fraud alerts).
 * Results are cached for 5 minutes.
 */
export async function getAdminUserIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedAdminIds && now < cacheExpiry) {
    return cachedAdminIds;
  }

  try {
    const result = await db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM admin_roles
       WHERE role IN ('admin', 'founder', 'moderator')`,
    );

    cachedAdminIds = result.rows.map((r) => r.user_id);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedAdminIds;
  } catch (error) {
    console.error('[AdminNotificationHelper] Failed to fetch admin user IDs:', error);
    return cachedAdminIds || []; // Return stale cache on error, or empty
  }
}

/**
 * Invalidate the admin ID cache (e.g., after admin role changes).
 */
export function invalidateAdminCache(): void {
  cachedAdminIds = null;
  cacheExpiry = 0;
}

/**
 * Send a notification to all admin users.
 * Failures for individual admins are logged but do not block others.
 */
export async function notifyAdmins(params: {
  title: string;
  body: string;
  deepLink: string;
  priority: NotificationPriority;
  metadata?: Record<string, unknown>;
}): Promise<{ sent: number; failed: number }> {
  const adminIds = await getAdminUserIds();

  if (adminIds.length === 0) {
    console.warn('[AdminNotificationHelper] No admin users found — admin notification skipped');
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  // Send to each admin concurrently (but cap concurrency with Promise.allSettled)
  const results = await Promise.allSettled(
    adminIds.map((adminId) =>
      NotificationService.createNotification({
        userId: adminId,
        category: 'security_alert', // Bypasses quiet hours
        title: params.title,
        body: params.body,
        deepLink: params.deepLink,
        // No taskId — admin is not a task participant
        metadata: params.metadata,
        channels: ['in_app', 'push', 'email'],
        priority: params.priority,
      }),
    ),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success) {
      sent++;
    } else {
      failed++;
      const reason =
        result.status === 'rejected'
          ? result.reason
          : !result.value.success ? result.value.error?.message : 'unknown';
      console.error('[AdminNotificationHelper] Failed to notify admin:', reason);
    }
  }

  console.log(
    `[AdminNotificationHelper] Admin notification sent: ${sent}/${adminIds.length} (${failed} failed)`,
  );

  return { sent, failed };
}
