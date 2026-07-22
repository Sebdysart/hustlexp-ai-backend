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

export interface PushResult {
  success: boolean;
  sent: number;
  failed: number;
  reason?: 'provider_unconfigured' | 'no_active_device' | 'provider_error';
}

// Wrap a promise with a timeout to prevent BullMQ stall-induced duplicate sends
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);

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
 * @param userId    Target user ID
 * @param title     Notification title
 * @param body      Notification body text (will be sanitized)
 * @param data      Optional key-value data payload
 * @param sensitive When true, body is replaced with a generic message
 * @returns Delivery result with sent/failed counts
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  sensitive = false
): Promise<PushResult> {
  // Guard: If Firebase messaging not initialized, return gracefully
  if (!messaging) {
    log.warn('Firebase messaging not initialized - skipping push notification');
    return { success: false, sent: 0, failed: 0, reason: 'provider_unconfigured' };
  }

  try {
    // Query active device tokens for user
    const tokenResult = await db.query<{ fcm_token: string }>(
      `SELECT dt.fcm_token FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE dt.user_id = $1
       AND dt.is_active = true
       AND u.is_banned = false
       AND u.account_status NOT IN ('DELETED', 'SUSPENDED')`,
      [userId]
    );

    const tokens = tokenResult.rows.map(row => row.fcm_token);

    // No tokens found - return gracefully (user may not have registered a device)
    if (tokens.length === 0) {
      return { success: true, sent: 0, failed: 0, reason: 'no_active_device' };
    }

    // Sanitize body: strip GPS coordinates / addresses; honour sensitive flag
    const safeBody = sanitizePushBody(body, sensitive);

    // Send multicast via FCM (25s timeout guards against BullMQ stall+duplicate-send)
    const response = await withTimeout(
      messaging.sendEachForMulticast({
        tokens,
        notification: { title, body: safeBody },
        data: data || undefined,
      }),
      25_000
    );

    // Process results: deactivate invalid tokens
    const sent = response.successCount;
    const failed = response.failureCount;

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

    return { success: sent > 0 || failed === 0, sent, failed };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    log.error({ err: errorMessage, userId }, 'push_notification_error');

    // Return gracefully - push failures should not break the caller
    return { success: false, sent: 0, failed: 0, reason: 'provider_error' };
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
