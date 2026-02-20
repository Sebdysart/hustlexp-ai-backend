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

import { messaging } from '../auth/firebase';
import { db } from '../db';
import { logger } from '../logger';

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
// SERVICE
// ============================================================================

/**
 * Send push notification to all active device tokens for a user
 *
 * @param userId Target user ID
 * @param title Notification title
 * @param body Notification body text
 * @param data Optional key-value data payload
 * @returns Delivery result with sent/failed counts
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<PushResult> {
  // Guard: If Firebase messaging not initialized, return gracefully
  if (!messaging) {
    log.warn('Firebase messaging not initialized - skipping push notification');
    return { success: true, sent: 0, failed: 0 };
  }

  try {
    // Query active device tokens for user
    const tokenResult = await db.query<{ fcm_token: string }>(
      `SELECT fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = true`,
      [userId]
    );

    const tokens = tokenResult.rows.map(row => row.fcm_token);

    // No tokens found - return gracefully (user may not have registered a device)
    if (tokens.length === 0) {
      return { success: true, sent: 0, failed: 0 };
    }

    // Send multicast via FCM
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: data || undefined,
    });

    // Process results: deactivate invalid tokens
    let sent = response.successCount;
    let failed = response.failureCount;

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
