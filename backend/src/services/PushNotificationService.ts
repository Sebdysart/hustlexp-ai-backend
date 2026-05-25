/**
 * PushNotificationService v1.0.0
 *
 * SYSTEM GUARANTEES: Firebase Cloud Messaging (FCM) Push Notification Delivery
 *
 * Sends push notifications via FCM to user device tokens.
 * Handles token lifecycle: deactivates invalid/expired tokens automatically.
 *
 * Pattern:
 * 1. Look up active device tokens for user
 * 2. Send multicast via FCM
 * 3. Deactivate failed tokens (unregistered/invalid)
 * 4. Return delivery counts
 *
 * Hard rule: Never fails loudly - returns gracefully if messaging not configured
 *
 * @see NOTIFICATION_SPEC.md
 */

import { messaging } from '../auth/firebase.js';
import { db } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'PushNotificationService' });

// ============================================================================
// TYPES
// ============================================================================

interface PushResult {
  success: boolean;
  sent: number;
  failed: number;
}

// FCM error codes that indicate a token should be deactivated
const DEACTIVATION_ERROR_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
];

// ============================================================================
// LOCATION SANITIZATION
// ============================================================================

/**
 * GPS coordinate pattern: matches decimal lat/lng pairs anywhere in text.
 * Covers forms like:
 *   "37.7749, -122.4194"
 *   "lat: 37.7749 lng: -122.4194"
 *   "-33.8688° S, 151.2093° E"
 */
const GPS_COORDINATE_PATTERN =
  /(-?\d{1,3}\.\d{4,})[°\s]*[NSns]?[,\s]+(-?\d{1,3}\.\d{4,})[°\s]*[EWew]?/g;

/**
 * Street address heuristic: sequences that look like "123 Some Street, City"
 * Anchored on a leading house number to reduce false positives.
 */
const STREET_ADDRESS_PATTERN =
  /\b\d{1,5}\s+[A-Za-z0-9 .,'#-]{5,60}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy)[^\n,]*/gi;

/**
 * Sanitize a push notification body before delivery.
 *
 * Rules (applied in order):
 *  1. If `sensitive` flag is set → replace entire body with generic message.
 *  2. Strip any GPS coordinate pairs → "[location protected]".
 *  3. Strip street-level addresses → "[location protected]".
 *
 * @param body   Raw notification body
 * @param sensitive Whether the originating entity is marked sensitive
 * @returns Sanitized body safe for push delivery
 */
export function sanitizePushBody(body: string, sensitive = false): string {
  if (sensitive) {
    return 'You have a new notification. Open the app for details.';
  }

  let sanitized = body.replace(GPS_COORDINATE_PATTERN, '[location protected]');
  sanitized = sanitized.replace(STREET_ADDRESS_PATTERN, '[location protected]');

  return sanitized;
}

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Send push notification to all active device tokens for a user
 *
 * The `body` is sanitized before delivery: GPS coordinates and street-level
 * addresses are replaced with "[location protected]". Pass `sensitive: true`
 * to suppress all location context entirely.
 *
 * @param userId         Target user ID
 * @param title          Notification title
 * @param body           Notification body text (will be sanitized)
 * @param data           Optional key-value data payload
 * @param sensitive      When true, body is replaced with a generic message
 * @param urgentWakeup   When true, adds APNs content-available:1 + priority 10 so the app
 *                       wakes in the background immediately AND shows a banner. Use for
 *                       dispatch pings — the app sets activePing before the user taps anything.
 * @returns Delivery result with sent/failed counts
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  sensitive = false,
  urgentWakeup = false,
  options?: {
    threadId?: string;
    interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
    category?: string;
  }
): Promise<PushResult> {
  // Guard: If Firebase messaging not initialized, return gracefully
  if (!messaging) {
    log.warn('Firebase messaging not initialized - skipping push notification');
    return { success: true, sent: 0, failed: 0 };
  }

  try {
    // Query active device tokens for user
    const tokenResult = await db.query<{ fcm_token: string }>(
      `SELECT dt.fcm_token FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE dt.user_id = $1
       AND dt.is_active = true
       AND u.account_status NOT IN ('DELETED', 'SUSPENDED')`,
      [userId]
    );

    const tokens = tokenResult.rows.map(row => row.fcm_token);

    log.info({ userId, tokenCount: tokens.length, urgentWakeup, title }, 'push_send_attempt');

    // No tokens found - return gracefully (user may not have registered a device)
    if (tokens.length === 0) {
      log.warn({ userId }, 'push_no_tokens — user has no active FCM tokens, notification not delivered');
      return { success: true, sent: 0, failed: 0 };
    }

    // Sanitize body: strip GPS coordinates / addresses; honour sensitive flag
    const safeBody = sanitizePushBody(body, sensitive);

    log.info({ userId, tokenCount: tokens.length, urgentWakeup, dataKeys: Object.keys(data || {}) }, 'push_fcm_sending');

    // Send multicast via FCM.
    // urgentWakeup=true (dispatch pings): shows a banner AND wakes the app immediately
    //   via content-available:1 + priority 10. iOS calls didReceiveRemoteNotification
    //   in the background so GoModeManager can set activePing before the user taps.
    // urgentWakeup=false: standard notification message (banner only, no background wake).
    const apnsAps: Record<string, unknown> = {};
    if (urgentWakeup) apnsAps['content-available'] = 1;
    if (options?.category) apnsAps['category'] = options.category;
    if (options?.threadId) apnsAps['thread-id'] = options.threadId;
    if (options?.interruptionLevel) apnsAps['interruption-level'] = options.interruptionLevel;

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body: safeBody },
      data: data || undefined,
      ...(Object.keys(apnsAps).length > 0 || urgentWakeup ? {
        apns: {
          ...(urgentWakeup ? { headers: { 'apns-priority': '10' } } : {}),
          payload: { aps: apnsAps },
        },
      } : {}),
      ...(urgentWakeup ? { android: { priority: 'high' as const } } : {}),
    });

    // Process results: deactivate invalid tokens
    const sent = response.successCount;
    const failed = response.failureCount;

    // Log per-token results for debugging
    response.responses.forEach((resp, index) => {
      if (resp.success) {
        log.info({ userId, tokenIndex: index, messageId: resp.messageId }, 'push_token_delivered');
      } else {
        log.error({ userId, tokenIndex: index, errorCode: resp.error?.code, errorMessage: resp.error?.message }, 'push_token_failed');
      }
    });

    if (response.failureCount > 0) {
      const deactivationPromises: Promise<void>[] = [];

      response.responses.forEach((resp, index) => {
        if (!resp.success && resp.error) {
          const errorCode = resp.error.code;

          if (DEACTIVATION_ERROR_CODES.includes(errorCode)) {
            // Token is invalid or unregistered - deactivate it
            const token = tokens[index];
            deactivationPromises.push(
              db.query(
                `UPDATE device_tokens SET is_active = false, updated_at = NOW() WHERE fcm_token = $1`,
                [token]
              ).then(() => {
                log.info({ userId, errorCode, reason: 'invalid_or_unregistered' }, 'push_token_deactivated');
              }).catch(dbError => {
                log.error({ err: dbError instanceof Error ? dbError.message : String(dbError), userId }, 'push_token_deactivation_failed');
              })
            );
          }
        }
      });

      // Wait for all deactivation operations
      await Promise.allSettled(deactivationPromises);
    }

    log.info({ userId, totalTokens: tokens.length, sent, failed }, 'push_notification_sent');

    return { success: true, sent, failed };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    log.error({ err: errorMessage, userId }, 'push_notification_error');

    // Return gracefully - push failures should not break the caller
    return { success: false, sent: 0, failed: 0 };
  }
}

/**
 * Send push notification to multiple users in batch
 *
 * Sends the same notification to all specified users concurrently.
 * Individual failures do not affect other users.
 *
 * @param userIds Array of target user IDs
 * @param title Notification title
 * @param body Notification body text
 * @param data Optional key-value data payload
 * @returns Aggregated delivery result
 */
export async function sendBatch(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<PushResult> {
  if (userIds.length === 0) {
    return { success: true, sent: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    userIds.map(userId => sendPushNotification(userId, title, body, data))
  );

  let totalSent = 0;
  let totalFailed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalSent += result.value.sent;
      totalFailed += result.value.failed;
    } else {
      totalFailed++;
    }
  }

  log.info({ userCount: userIds.length, totalSent, totalFailed }, 'push_batch_sent');

  return { success: true, sent: totalSent, failed: totalFailed };
}
