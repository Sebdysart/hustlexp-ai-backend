/**
 * NotificationService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §11, NOTIFICATION_SPEC.md
 * 
 * Implements notification system with priority tiers, quiet hours, and preferences.
 * Core Principle: Notifications are information, not interruptions.
 * 
 * @see backend/database/constitutional-schema.sql §11.3 (notifications, notification_preferences tables)
 * @see PRODUCT_SPEC.md §11
 * @see staging/NOTIFICATION_SPEC.md
 */

import { randomUUID } from 'crypto';
import { db, isInvariantViolation, getErrorMessage, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { logger } from '../logger.js';
import {
  applyNotificationPresentation,
  NOTIFICATION_POLICY,
  nextQuietHoursEnd,
  resolveNotificationChannels,
  validateNotificationDeepLink,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationClass,
} from './NotificationPolicy.js';

const log = logger.child({ service: 'NotificationService' });

class NotificationFrequencyLimitError extends Error {
  constructor(readonly window: 'hour' | 'day') {
    super(`Notification ${window} frequency limit exceeded`);
    this.name = 'NotificationFrequencyLimitError';
  }
}

function notificationFrequencyCount(value: unknown): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('NOTIFICATION_FREQUENCY_COUNTER_INVALID');
  }
  return normalized;
}

// ============================================================================
// TYPES
// ============================================================================

export type { NotificationCategory } from './NotificationPolicy.js';
export type { NotificationChannel } from './NotificationPolicy.js';

export type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Notification {
  id: string;
  user_id: string;
  category: string; // VARCHAR(50) - flexible category
  title: string; // VARCHAR(200)
  body: string; // TEXT
  deep_link: string; // TEXT (required)
  task_id?: string | null;
  metadata?: Record<string, unknown>; // JSONB (default '{}')
  channels: NotificationChannel[]; // TEXT[] - class-owned defaults when omitted
  priority: NotificationPriority;
  sent_at?: Date | null; // NULL = pending
  delivered_at?: Date | null; // NULL = not delivered
  read_at?: Date | null; // NULL = unread
  clicked_at?: Date | null; // NULL = not clicked
  group_id?: string | null; // UUID - for grouping (NULL = not grouped)
  group_position?: number | null; // INTEGER - position in group (1, 2, 3, ...)
  expires_at?: Date | null; // Optional expiration
  notification_class?: NotificationClass;
  object_type?: string;
  object_id?: string;
  dedupe_key?: string;
  supersession_key?: string;
  superseded_at?: Date | null;
  superseded_by_notification_id?: string | null;
  available_at?: Date;
  delivery_state?: string;
  delivery_attempts?: number;
  terminal_failure_at?: Date | null;
  terminal_failure_reason?: string | null;
  focus_task_id?: string | null;
  focus_deferred_at?: Date | null;
  focus_released_at?: Date | null;
  created_at: Date;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  quiet_hours_enabled: boolean; // Default: true
  quiet_hours_start: string; // TIME - default '22:00:00'
  quiet_hours_end: string; // TIME - default '07:00:00'
  quiet_hours_timezone: string; // IANA timezone - default America/Los_Angeles
  push_enabled: boolean; // Default: true
  email_enabled: boolean; // Default: false
  sms_enabled: boolean; // Default: false
  category_preferences: Record<string, {
    enabled?: boolean;
    sound?: boolean;
    badge?: boolean;
    quiet_hours_override?: boolean; // Legacy preference; binding class policy controls bypass
  }>; // JSONB
  created_at: Date;
  updated_at: Date;
}

export interface CreateNotificationParams {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  deepLink: string; // Required - deep link to relevant content
  taskId?: string;
  metadata?: Record<string, unknown>;
  channels?: NotificationChannel[]; // Binding class defaults apply when omitted
  priority?: NotificationPriority; // Default: 'MEDIUM'
  expiresAt?: Date;
  objectRef?: { type: string; id: string };
  dedupeKey?: string;
}

export interface UpdatePreferencesParams {
  userId: string;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string; // TIME format: 'HH:MM:SS'
  quietHoursEnd?: string; // TIME format: 'HH:MM:SS'
  quietHoursTimezone?: string; // IANA timezone
  pushEnabled?: boolean;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  categoryPreferences?: Record<string, unknown>;
}

// BUG 5 FIX: Categories that bypass the frequency cap entirely.
// security_alert: an attacker can exhaust the 20/day limit, silencing real alerts.
// payment_released: already has Infinity limits but guarded explicitly here for safety.
// These categories must NEVER be silently dropped due to frequency limits.
const FREQUENCY_BYPASS_CATEGORIES = new Set<NotificationCategory>(['security_alert', 'payment_released']);

// Frequency limits per category (NOTIFICATION_SPEC.md §2.2)
export const NOTIFICATION_FREQUENCY_LIMITS: Record<NotificationCategory, { perHour: number; perDay: number }> = {
  new_matching_task: { perHour: 5, perDay: 20 },
  live_mode_task: { perHour: 10, perDay: 50 },
  instant_task_available: { perHour: Infinity, perDay: Infinity }, // One-interrupt-at-a-time enforced separately
  // Keep a notification-layer backstop even when MessagingService's own
  // sender/task bucket is bypassed or misconfigured. Excess notifications are
  // batched by createNotification instead of producing unlimited push traffic.
  message_received: { perHour: 30, perDay: 200 },
  unread_messages: { perHour: 6, perDay: 24 },
  task_accepted: { perHour: Infinity, perDay: Infinity },
  task_completed: { perHour: Infinity, perDay: Infinity },
  provider_arrived: { perHour: Infinity, perDay: Infinity },
  proof_submitted: { perHour: Infinity, perDay: Infinity },
  proof_approved: { perHour: Infinity, perDay: Infinity },
  proof_rejected: { perHour: Infinity, perDay: Infinity },
  clarification_required: { perHour: Infinity, perDay: Infinity },
  scope_change_required: { perHour: Infinity, perDay: Infinity },
  recurring_budget_exception: { perHour: 2, perDay: 4 },
  task_cancelled: { perHour: Infinity, perDay: Infinity },
  task_expired: { perHour: Infinity, perDay: Infinity },
  escrow_funded: { perHour: Infinity, perDay: Infinity },
  payment_failed: { perHour: Infinity, perDay: Infinity },
  payment_released: { perHour: Infinity, perDay: Infinity },
  payment_due: { perHour: 1, perDay: 1 }, // Max 1 tax reminder per day
  refund_issued: { perHour: Infinity, perDay: Infinity },
  payout_failed: { perHour: Infinity, perDay: Infinity },
  dispute_opened: { perHour: Infinity, perDay: Infinity },
  dispute_resolved: { perHour: Infinity, perDay: Infinity },
  trust_tier_upgraded: { perHour: 3, perDay: 10 },
  badge_earned: { perHour: 3, perDay: 10 },
  account_suspended: { perHour: 5, perDay: 20 },
  security_alert: { perHour: 5, perDay: 20 },
  password_changed: { perHour: 5, perDay: 20 },
  welcome: { perHour: 1, perDay: 1 },
  weekly_recap: { perHour: 1, perDay: 1 },
  business_operational_digest: { perHour: 1, perDay: 1 },
  export_ready: { perHour: Infinity, perDay: Infinity },
  growth_rebook: { perHour: 1, perDay: 2 },
  maintenance_suggestion: { perHour: 1, perDay: 2 },
  provider_reactivation: { perHour: 1, perDay: 1 },
};

type NotificationObjectReference = { type: string; id: string };

const OBJECT_ID_METADATA_KEYS = [
  'eventId', 'messageId', 'queueItemId', 'appealId', 'requestId', 'waitlistId',
  'patternId', 'exportId', 'escrowId', 'payoutId', 'accountId', 'invoiceId',
] as const;

const FOCUS_DEFERRED_UNTIL = new Date('9999-12-31T23:59:59.999Z');

function validObjectReference(ref: NotificationObjectReference): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/i.test(ref.type)
    && ref.id.trim().length > 0
    && ref.id.trim().length <= 255
    && !/[\r\n]/.test(ref.id);
}

function deepLinkObjectReference(deepLink: string): NotificationObjectReference | null {
  const value = deepLink.trim();
  const parts = value.startsWith('/')
    ? value.split('/').filter(Boolean)
    : (() => {
      try {
        const parsed = new URL(value);
        return [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)];
      } catch {
        return [];
      }
    })();
  if (parts.length < 2) return null;
  return { type: parts[0].replace(/s$/, '') || 'object', id: parts[1] };
}

function resolveObjectReference(params: CreateNotificationParams): NotificationObjectReference | null {
  if (params.objectRef && validObjectReference(params.objectRef)) {
    return { type: params.objectRef.type.trim().toLowerCase(), id: params.objectRef.id.trim() };
  }
  if (params.taskId?.trim()) return { type: 'task', id: params.taskId.trim() };

  for (const key of OBJECT_ID_METADATA_KEYS) {
    const value = params.metadata?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { type: key.replace(/Id$/, '').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), id: value.trim() };
    }
  }

  const linked = deepLinkObjectReference(params.deepLink);
  if (linked && validObjectReference(linked)) return linked;

  // Account/security/settings notifications are still object-specific: their
  // referenced object is the recipient account, never an unscoped broadcast.
  if (/^(?:app|hustlexp):\/\/(?:settings|support|profile)(?:\/|$)/.test(params.deepLink)) {
    return { type: 'user', id: params.userId };
  }
  return null;
}

function resolveDedupeKey(
  params: CreateNotificationParams,
  objectRef: NotificationObjectReference,
): string | null {
  if (params.dedupeKey !== undefined) {
    const explicit = params.dedupeKey.trim();
    return explicit && explicit.length <= 255 && !/[\r\n]/.test(explicit) ? explicit : null;
  }
  const version = params.metadata?.eventVersion;
  const source = typeof version === 'string' || typeof version === 'number' ? String(version) : '1';
  const derived = `notification:${params.category}:${params.userId}:${objectRef.type}:${objectRef.id}:v${source}`;
  return derived.length <= 255 ? derived : null;
}

type NotificationReplayCandidate = Notification & {
  dedupe_identity_matches?: boolean;
};

type NotificationReplayResolution =
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'match'; notification: Notification };

async function resolveNotificationReplay(
  dedupeKey: string,
  userId: string,
  category: NotificationCategory,
  objectRef: NotificationObjectReference,
  query: QueryFn = db.query,
): Promise<NotificationReplayResolution> {
  const replay = await query<NotificationReplayCandidate>(
    `SELECT direct_notification.*,
            (direct_notification.user_id = $2
             AND direct_notification.category = $3
             AND direct_notification.object_type = $4
             AND direct_notification.object_id = $5) AS dedupe_identity_matches
       FROM notifications AS direct_notification
      WHERE dedupe_key = $1
     UNION ALL
     SELECT batched_notification.*,
            (batched_notification.user_id = $2
             AND batched_notification.category = $3
             AND batched_item->>'object_type' = $4
             AND batched_item->>'object_id' = $5) AS dedupe_identity_matches
       FROM notifications AS batched_notification
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(batched_notification.metadata->'batched_items') = 'array'
             THEN batched_notification.metadata->'batched_items'
           ELSE '[]'::JSONB
         END
       ) AS batched_item
      WHERE batched_item->>'dedupe_key' = $1`,
    [dedupeKey, userId, category, objectRef.type, objectRef.id],
  );
  if (replay.rows.length === 0) return { kind: 'missing' };

  let notification: Notification | null = null;
  for (const candidate of replay.rows) {
    // PostgreSQL always supplies this computed column. Unit-test query doubles
    // may omit it after already applying the SQL predicate; treat only an
    // explicit false value as a collision.
    const identityMatches = candidate.dedupe_identity_matches ?? true;
    if (!identityMatches) return { kind: 'conflict' };
    if (!notification) {
      const { dedupe_identity_matches: _identityMatches, ...persistedNotification } = candidate;
      notification = persistedNotification;
    }
  }
  return notification
    ? { kind: 'match', notification }
    : { kind: 'missing' };
}

async function lockNotificationRecipientAndDedupe(
  userId: string,
  dedupeKey: string,
  query: QueryFn,
): Promise<boolean> {
  // Every normal acceptance and batch receipt takes locks in this exact order:
  // global producer-event identity first, then recipient. The transaction-level
  // advisory lock extends notifications(dedupe_key) uniqueness to metadata-held
  // batch receipts without relying on a process-local mutex.
  const recipient = await query<{ id: string }>(
    `WITH notification_dedupe_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($2, 0)) AS acquired
     )
     SELECT id FROM users
     CROSS JOIN notification_dedupe_lock
     WHERE id = $1
     FOR UPDATE OF users`,
    [userId, dedupeKey],
  );
  return recipient.rows.length > 0;
}

function defaultNotificationPreferences(userId: string): NotificationPreferences {
  return {
    id: '',
    user_id: userId,
    quiet_hours_enabled: true,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '07:00:00',
    quiet_hours_timezone: 'America/Los_Angeles',
    push_enabled: true,
    email_enabled: false,
    sms_enabled: false,
    category_preferences: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

async function loadNotificationPreferences(
  userId: string,
  query: QueryFn = db.query,
): Promise<NotificationPreferences> {
  const result = await query<NotificationPreferences>(
    'SELECT * FROM notification_preferences WHERE user_id = $1',
    [userId],
  );
  return result.rows[0] ?? defaultNotificationPreferences(userId);
}

// ============================================================================
// SERVICE
// ============================================================================

export const NotificationService = {
  // --------------------------------------------------------------------------
  // CREATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create and send a notification
   * 
   * NOTIFICATION_SPEC.md §2: Respects quiet hours, frequency limits, user preferences
   */
  createNotification: async (
    params: CreateNotificationParams
  ): Promise<ServiceResult<Notification>> => {
    const {
      userId,
      category,
      title,
      body,
      deepLink,
      taskId,
      metadata,
      channels: requestedChannels,
      priority = 'MEDIUM',
      expiresAt,
    } = params;

    const policy = NOTIFICATION_POLICY[category];
    const channelResolution = resolveNotificationChannels(policy, requestedChannels);
    if (!channelResolution.valid) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: `Invalid notification channels: ${channelResolution.reason}`,
        },
      };
    }
    const channels = channelResolution.channels;
    const presentation = applyNotificationPresentation(policy, title, metadata);
    const notificationTitle = presentation.title;
    const notificationMetadata = presentation.metadata;
    const deepLinkValidation = validateNotificationDeepLink(deepLink);
    if (!deepLinkValidation.valid) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: `Invalid notification deep link: ${deepLinkValidation.reason}`,
        },
      };
    }
    const objectRef = resolveObjectReference(params);
    if (!objectRef) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: 'Notification requires a specific object reference',
        },
      };
    }
    const dedupeKey = resolveDedupeKey(params, objectRef);
    if (!dedupeKey) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: 'Notification requires a valid deduplication key',
        },
      };
    }
    const supersessionKey = `${userId}:${objectRef.type}:${objectRef.id}`;
    const limits = NOTIFICATION_FREQUENCY_LIMITS[category]
      ?? { perHour: Infinity, perDay: Infinity };
    // Security and payment-recovery alerts cannot be silenced by exhausting a
    // recipient's ordinary notification quota.
    const bypassFrequency = FREQUENCY_BYPASS_CATEGORIES.has(category);
    
    try {
      // NOTIF-1: Verify user exists and has access to task (if task_id provided)
      if (taskId) {
        const taskResult = await db.query<{
          poster_id: string;
          worker_id: string | null;
        }>(
          'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
          [taskId]
        );
        
        if (taskResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }
        
        const task = taskResult.rows[0];
        
        // Verify user is a participant
        if (task.poster_id !== userId && task.worker_id !== userId) {
          return {
            success: false,
            error: {
              code: ErrorCodes.FORBIDDEN,
              message: 'User is not a participant in this task',
            },
          };
        }
      }

      // Caller-supplied keys identify an explicit producer event and can take the
      // fast replay path before mutable preferences. Safely derived keys are
      // rechecked under the recipient lock before any frequency decision below.
      // Task authorization remains mandatory, and the lookup binds the complete
      // identity so a global-key collision cannot disclose another user's row.
      if (params.dedupeKey !== undefined) {
        const replay = await resolveNotificationReplay(dedupeKey, userId, category, objectRef);
        if (replay.kind === 'match') return { success: true, data: replay.notification };
        if (replay.kind === 'conflict') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_INPUT,
              message: 'Notification deduplication key conflicts with a different event identity',
            },
          };
        }
      }
      
      // PostgreSQL is the acceptance and frequency authority. Locking the
      // recipient row serializes bounded notification decisions without a
      // collision-prone application lock. The notification, delivery facts,
      // and channel outbox rows commit together on the same connection.
      const transactionResult = await db.transaction(async (query) => {
        if (!await lockNotificationRecipientAndDedupe(userId, dedupeKey, query)) {
          return { kind: 'recipient_missing' as const };
        }

        const acceptedReplay = await resolveNotificationReplay(
          dedupeKey,
          userId,
          category,
          objectRef,
          query,
        );
        if (acceptedReplay.kind === 'match') {
          return { kind: 'accepted' as const, notification: acceptedReplay.notification };
        }
        if (acceptedReplay.kind === 'conflict') {
          return { kind: 'dedupe_conflict' as const };
        }

        // Consent, quiet hours, channel eligibility, the frequency decision,
        // and acceptance all share the recipient serialization boundary.
        // updatePreferences obtains the same user-row lock, so a concurrent
        // opt-out cannot race a notification created from stale preferences.
        const preferences = await loadNotificationPreferences(userId, query);
        const categoryPrefs = preferences.category_preferences[category];
        if (categoryPrefs?.enabled === false) {
          return {
            kind: 'preference_disabled' as const,
            message: `Notifications for category ${category} are disabled by user`,
          };
        }
        if (policy.consent === 'explicit_opt_in' && categoryPrefs?.enabled !== true) {
          return {
            kind: 'preference_disabled' as const,
            message: `Growth notification ${category} requires explicit opt-in`,
          };
        }

        let enabledChannels = channels.filter((channel) => {
          if (channel === 'push' && !preferences.push_enabled) return false;
          if (channel === 'email' && !preferences.email_enabled) return false;
          if (channel === 'sms' && !preferences.sms_enabled) return false;
          return true;
        });
        if (enabledChannels.length === 0 && !channels.includes('in_app')) {
          return {
            kind: 'preference_disabled' as const,
            message: 'All notification channels are disabled by user',
          };
        }
        if (enabledChannels.length === 0) enabledChannels = ['in_app'];

        const policyBypass = policy.quietHours === 'security_override'
          || (policy.quietHours === 'active_task_override' && objectRef.type === 'task');
        const quietHoursEnd = preferences.quiet_hours_enabled && !policyBypass
          ? nextQuietHoursEnd(
            new Date(),
            preferences.quiet_hours_start,
            preferences.quiet_hours_end,
            preferences.quiet_hours_timezone || 'America/Los_Angeles',
          )
          : null;
        const availableAt = quietHoursEnd ?? new Date();

        if (!bypassFrequency && (limits.perHour !== Infinity || limits.perDay !== Infinity)) {
          const counts = await query<{ hourly_count: string; daily_count: string }>(
            `SELECT
               COUNT(*) FILTER (
                 WHERE created_at >= (
                   date_trunc('hour', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                 )
               )::TEXT AS hourly_count,
               COUNT(*)::TEXT AS daily_count
             FROM notifications
             WHERE user_id = $1
               AND category = $2
               AND created_at >= (
                 date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               )`,
            [userId, category],
          );
          const hourlyCount = notificationFrequencyCount(counts.rows[0]?.hourly_count ?? '0');
          const dailyCount = notificationFrequencyCount(counts.rows[0]?.daily_count ?? '0');
          if (Number.isFinite(limits.perDay) && dailyCount >= limits.perDay) {
            throw new NotificationFrequencyLimitError('day');
          }
          if (Number.isFinite(limits.perHour) && hourlyCount >= limits.perHour) {
            throw new NotificationFrequencyLimitError('hour');
          }
        }

        // Resolve grouping only after this transaction owns the recipient lock,
        // so concurrent accepts cannot choose the same group position.
        const groupingResult = await findGroupableNotification(
          userId,
          category,
          taskId,
          query,
        );
        let groupId: string | null = null;
        let groupPosition: number | null = null;
        if (groupingResult.success) {
          if (groupingResult.data) {
            groupId = groupingResult.data.groupId;
            groupPosition = groupingResult.data.groupPosition;
          } else {
            groupId = randomUUID();
            groupPosition = 1;
          }
        }

        const result = await query<Notification>(
          `WITH active_focus AS (
            SELECT task.id
            FROM tasks task
            WHERE $20::BOOLEAN
              AND task.worker_id = $1
              AND task.state = 'ACCEPTED'
              AND task.progress_state IN ('ACCEPTED','TRAVELING','WORKING')
            ORDER BY COALESCE(task.accepted_at, task.updated_at) DESC, task.id
            LIMIT 1
          )
          INSERT INTO notifications (
            user_id, category, title, body, deep_link, task_id, metadata,
            channels, priority, expires_at, group_id, group_position,
            notification_class, object_type, object_id, dedupe_key, supersession_key,
            available_at, delivery_state, focus_task_id, focus_deferred_at, created_at
          )
          SELECT
            $1, $2, $3, $4, $5, $6, $7::JSONB, $8::TEXT[], $9, $10, $11, $12,
            $13, $14, $15, $16, $17,
            CASE WHEN focus.id IS NULL THEN $18::TIMESTAMPTZ ELSE $21::TIMESTAMPTZ END,
            CASE WHEN focus.id IS NULL THEN $19 ELSE 'deferred_focus' END,
            focus.id,
            CASE WHEN focus.id IS NULL THEN NULL ELSE NOW() END,
            NOW()
          FROM (SELECT 1) seed
          LEFT JOIN active_focus focus ON TRUE
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING *`,
          [
            userId,
            category,
            notificationTitle,
            body,
            deepLink,
            taskId || null,
            JSON.stringify(notificationMetadata),
            enabledChannels,
            priority,
            expiresAt || null,
            groupId,
            groupPosition,
            policy.notificationClass,
            objectRef.type,
            objectRef.id,
            dedupeKey,
            supersessionKey,
            availableAt,
            quietHoursEnd ? 'deferred_quiet_hours' : 'pending',
            policy.focusSuppression === 'defer_during_active_execution',
            FOCUS_DEFERRED_UNTIL,
          ],
        );

        if (result.rows.length === 0) {
          const conflictReplay = await resolveNotificationReplay(
            dedupeKey,
            userId,
            category,
            objectRef,
            query,
          );
          return conflictReplay.kind === 'match'
            ? { kind: 'accepted' as const, notification: conflictReplay.notification }
            : { kind: 'dedupe_conflict' as const };
        }

        const notification = result.rows[0];
        if (policy.supersedes.length > 0) {
          await supersedePriorNotifications(
            notification.id,
            supersessionKey,
            policy.supersedes,
            query,
          );
        }

        const persistedAvailableAt = notification.available_at
          ? new Date(notification.available_at)
          : availableAt;
        const canonicalNotification = await queueNotificationChannels(
          notification,
          enabledChannels,
          persistedAvailableAt,
          Boolean(quietHoursEnd),
          notification.delivery_state === 'deferred_focus',
          query,
        );
        return { kind: 'accepted' as const, notification: canonicalNotification };
      });

      if (transactionResult.kind === 'recipient_missing') {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification recipient ${userId} not found`,
          },
        };
      }
      if (transactionResult.kind === 'dedupe_conflict') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Notification deduplication key conflicts with a different event identity',
          },
        };
      }
      if (transactionResult.kind === 'preference_disabled') {
        return {
          success: false,
          error: {
            code: ErrorCodes.PREFERENCE_DISABLED,
            message: transactionResult.message,
          },
        };
      }
      return { success: true, data: transactionResult.notification };
    } catch (error) {
      if (error instanceof NotificationFrequencyLimitError) {
        if (error.window === 'hour') {
          const batchResult = await batchNotification(userId, category, {
            title: notificationTitle,
            body,
            deepLink,
            taskId,
            metadata: notificationMetadata,
            priority,
            dedupeKey,
            objectRef,
          });
          if (batchResult.success) return batchResult;
          if (batchResult.error.code === 'DEDUPE_CONFLICT') {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_INPUT,
                message: 'Notification deduplication key conflicts with a different event identity',
              },
            };
          }
        }
        return {
          success: false,
          error: {
            code: ErrorCodes.RATE_LIMIT_EXCEEDED,
            message: error.window === 'day'
              ? `Daily limit exceeded for category ${category}. Maximum ${limits.perDay} per day`
              : `Frequency limit exceeded for category ${category}. Maximum ${limits.perHour} per hour`,
          },
        };
      }
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Recreate one missing external-channel work item after an initial outbox write
   * failed. Eligibility is rechecked from authoritative delivery state; provider
   * retries that already have channel work are handled by their normal workers.
   */
  retryDelivery: async (
    notificationId: string,
    channel: Exclude<NotificationChannel, 'in_app'>,
    recoveryClaimId?: string,
  ): Promise<ServiceResult<{ queued: boolean }>> => {
    try {
      const eligible = await db.query<Notification & { delivery_available_at: Date | string }>(
        `SELECT notification.*, delivery.available_at AS delivery_available_at
         FROM notifications notification
         JOIN notification_deliveries delivery
           ON delivery.notification_id = notification.id
          AND delivery.channel = $2
         WHERE notification.id = $1
           AND notification.superseded_at IS NULL
           AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
           AND delivery.state = 'retry_pending'
           AND (
             ($3::UUID IS NULL AND delivery.recovery_claim_id IS NULL)
             OR (
               $3::UUID IS NOT NULL
               AND delivery.recovery_claim_id=$3::UUID
               AND delivery.recovery_claim_deadline_at > NOW()
             )
           )
           AND GREATEST(
             delivery.available_at,
             COALESCE(delivery.next_retry_at, delivery.available_at)
           ) <= NOW()`,
        [notificationId, channel, recoveryClaimId ?? null],
      );
      const notification = eligible.rows[0];
      if (!notification) return { success: true, data: { queued: false } };

      const availableAt = new Date(notification.delivery_available_at);
      if (!Number.isFinite(availableAt.getTime())) throw new Error('Invalid delivery availability');
      if (channel === 'email') await queueEmailNotification(notification, availableAt);
      else if (channel === 'push') await queuePushNotification(notification, availableAt);
      else await queueSMSNotification(notification, availableAt);

      const deferred = availableAt.getTime() > Date.now();
      const state = deferred ? 'deferred_quiet_hours' : 'queued';
      const recovered = await db.query(
        `WITH recovered AS (
           UPDATE notification_deliveries
           SET state = $3,
               next_retry_at = NULL,
               last_error = NULL,
               recovery_claim_id = NULL,
               recovery_claimed_at = NULL,
               recovery_claim_deadline_at = NULL,
               updated_at = NOW()
           WHERE notification_id = $1 AND channel = $2
             AND state = 'retry_pending'
             AND (
               ($4::UUID IS NULL AND recovery_claim_id IS NULL)
               OR (
                 $4::UUID IS NOT NULL
                 AND recovery_claim_id=$4::UUID
                 AND recovery_claim_deadline_at > NOW()
               )
             )
           RETURNING notification_id
         )
          UPDATE notifications
          SET delivery_state = CASE
                WHEN delivery_state IN (
                  'delivered','provider_accepted','provider_outcome_unknown',
                  'provider_in_flight','failed_terminal','suppressed'
                ) THEN delivery_state
                ELSE $3
              END,
             sent_at = COALESCE(sent_at, NOW()),
             updated_at = NOW()
         WHERE id IN (SELECT notification_id FROM recovered)`,
        [notificationId, channel, state, recoveryClaimId ?? null],
      );
      return { success: true, data: { queued: (recovered.rowCount ?? 0) > 0 } };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Notification delivery recovery failed',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get notifications for a user
   */
  getUserNotifications: async (
    userId: string,
    limit: number = 50,
    offset: number = 0,
    unreadOnly: boolean = false
  ): Promise<ServiceResult<Notification[]>> => {
    try {
      let sql = `SELECT * FROM notifications WHERE user_id = $1`;
      const params: unknown[] = [userId];
      
      if (unreadOnly) {
        sql += ` AND read_at IS NULL`;
      }
      
      // Filter expired notifications
      sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;
      
      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const result = await db.query<Notification>(sql, params);
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get unread notification count
   */
  getUnreadCount: async (userId: string): Promise<ServiceResult<number>> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM notifications
         WHERE user_id = $1 AND read_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId]
      );
      
      return {
        success: true,
        data: parseInt(result.rows[0]?.count || '0', 10),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get notification by ID
   */
  getNotificationById: async (
    notificationId: string,
    userId: string // Verify user owns notification
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `SELECT * FROM notifications
         WHERE id = $1 AND user_id = $2`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found or you do not have permission to view it`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // UPDATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Mark notification as read
   */
  markAsRead: async (
    notificationId: string,
    userId: string
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL
         RETURNING *`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found, already read, or you do not have permission`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Mark all notifications as read for a user
   */
  markAllAsRead: async (
    userId: string
  ): Promise<ServiceResult<{ marked: number }>> => {
    try {
      const result = await db.query(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE user_id = $1 AND read_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId]
      );
      const count = result.rowCount ?? 0;

      return {
        success: true,
        data: {
          marked: count,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Mark notification as clicked (tracking)
   */
  markAsClicked: async (
    notificationId: string,
    userId: string
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `UPDATE notifications
         SET clicked_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found or you do not have permission`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // PREFERENCES
  // --------------------------------------------------------------------------
  
  /**
   * Get notification preferences for a user
   */
  getPreferences: async (
    userId: string
  ): Promise<ServiceResult<NotificationPreferences>> => {
    try {
      return {
        success: true,
        data: await loadNotificationPreferences(userId),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Update notification preferences
   */
  updatePreferences: async (
    params: UpdatePreferencesParams
  ): Promise<ServiceResult<NotificationPreferences>> => {
    const { userId, ...updates } = params;
    
    try {
      if (updates.quietHoursTimezone !== undefined) {
        new Intl.DateTimeFormat('en-US', { timeZone: updates.quietHoursTimezone }).format();
      }

      const transactionResult = await db.transaction(async (query) => {
        // Preference mutation and notification acceptance serialize on the
        // same recipient row. This closes the stale-consent race in which an
        // opt-out could commit while acceptance used an earlier snapshot.
        const recipient = await query<{ id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        if (recipient.rows.length === 0) {
          return { kind: 'recipient_missing' as const };
        }

        const existing = await loadNotificationPreferences(userId, query);
        if (!existing.id) {
          const created = await query<NotificationPreferences>(
            `INSERT INTO notification_preferences (
              user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
              push_enabled, email_enabled, sms_enabled, category_preferences
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB)
            RETURNING *`,
            [
              userId,
              updates.quietHoursEnabled ?? true,
              updates.quietHoursStart || '22:00:00',
              updates.quietHoursEnd || '07:00:00',
              updates.quietHoursTimezone || 'America/Los_Angeles',
              updates.pushEnabled ?? true,
              updates.emailEnabled ?? false,
              updates.smsEnabled ?? false,
              JSON.stringify(updates.categoryPreferences || {}),
            ],
          );
          if (!created.rows[0]) throw new Error('Notification preferences insert returned no row');
          return { kind: 'accepted' as const, preferences: created.rows[0] };
        }

        const updateFields: string[] = [];
        const updateValues: unknown[] = [];
        let paramIndex = 1;
        if (updates.quietHoursEnabled !== undefined) {
          updateFields.push(`quiet_hours_enabled = $${paramIndex++}`);
          updateValues.push(updates.quietHoursEnabled);
        }
        if (updates.quietHoursStart !== undefined) {
          updateFields.push(`quiet_hours_start = $${paramIndex++}`);
          updateValues.push(updates.quietHoursStart);
        }
        if (updates.quietHoursEnd !== undefined) {
          updateFields.push(`quiet_hours_end = $${paramIndex++}`);
          updateValues.push(updates.quietHoursEnd);
        }
        if (updates.quietHoursTimezone !== undefined) {
          updateFields.push(`quiet_hours_timezone = $${paramIndex++}`);
          updateValues.push(updates.quietHoursTimezone);
        }
        if (updates.pushEnabled !== undefined) {
          updateFields.push(`push_enabled = $${paramIndex++}`);
          updateValues.push(updates.pushEnabled);
        }
        if (updates.emailEnabled !== undefined) {
          updateFields.push(`email_enabled = $${paramIndex++}`);
          updateValues.push(updates.emailEnabled);
        }
        if (updates.smsEnabled !== undefined) {
          updateFields.push(`sms_enabled = $${paramIndex++}`);
          updateValues.push(updates.smsEnabled);
        }
        if (updates.categoryPreferences !== undefined) {
          updateFields.push(`category_preferences = $${paramIndex++}::JSONB`);
          updateValues.push(JSON.stringify(updates.categoryPreferences));
        }
        if (updateFields.length === 0) {
          return { kind: 'accepted' as const, preferences: existing };
        }

        updateValues.push(userId);
        const updated = await query<NotificationPreferences>(
          `UPDATE notification_preferences
           SET ${updateFields.join(', ')}, updated_at = NOW()
           WHERE user_id = $${paramIndex}
           RETURNING *`,
          updateValues,
        );
        if (!updated.rows[0]) throw new Error('Notification preferences update returned no row');
        return { kind: 'accepted' as const, preferences: updated.rows[0] };
      });

      if (transactionResult.kind === 'recipient_missing') {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification preference owner ${userId} not found`,
          },
        };
      }
      return {
        success: true,
        data: transactionResult.preferences,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // CLEANUP (Background Job)
  // --------------------------------------------------------------------------
  
  /**
   * Clean up expired notifications (NOTIF-5: Notifications expire after 30 days)
   * 
   * This should be called by a background job daily
   */
  cleanupExpiredNotifications: async (): Promise<ServiceResult<{ deleted: number }>> => {
    try {
      // Delete notifications expired more than 30 days ago, or old notifications
      // that never had an expiry set (D51-5: prevents unbounded accumulation).
      const result = await db.query(
        `DELETE FROM notifications
         WHERE (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '30 days')
            OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '90 days')`
      );
      const count = result.rowCount ?? 0;

      return {
        success: true,
        data: {
          deleted: count,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // HELPER METHODS
  // --------------------------------------------------------------------------
  
  /**
   * Get recent notification count for frequency limiting
   */
  getRecentNotificationCount: async (
    userId: string,
    category: NotificationCategory,
    minutes: number
  ): Promise<number> => {
    if (!Number.isSafeInteger(minutes) || minutes <= 0) {
      throw new Error('NOTIFICATION_FREQUENCY_WINDOW_INVALID');
    }
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM notifications
         WHERE user_id = $1 AND category = $2
           AND created_at >= NOW() - ($3 * INTERVAL '1 minute')`,
        [userId, category, minutes]
      );
      
      return notificationFrequencyCount(result.rows[0]?.count ?? '0');
    } catch (error) {
      log.error({ error, userId, category }, 'Notification count read failed closed');
      throw error;
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS - NOTIFICATION BATCHING & GROUPING
// ============================================================================

async function supersedePriorNotifications(
  notificationId: string,
  supersessionKey: string,
  categories: readonly NotificationCategory[],
  query: QueryFn = db.query,
): Promise<void> {
  // Acquire target notification locks in a statement that completes before the
  // state-recompute statement. A lock CTE inside the latter can wait while
  // retaining a stale PostgreSQL statement snapshot, allowing an actual
  // in-flight/accepted send to be mis-recorded as cancelled.
  await query(
    `SELECT id
     FROM notifications
     WHERE supersession_key=$2
       AND id<>$1
       AND category=ANY($3::TEXT[])
       AND superseded_at IS NULL
     ORDER BY id
     FOR UPDATE`,
    [notificationId, supersessionKey, categories],
  );
  await query(
     `WITH supersession_targets AS MATERIALIZED (
       SELECT notifications.id,
          CASE
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'delivered'
             ) THEN 'delivered'
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'provider_accepted'
             ) THEN 'provider_accepted'
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'provider_outcome_unknown'
             ) THEN 'provider_outcome_unknown'
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'provider_in_flight'
             ) THEN 'provider_in_flight'
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'failed_terminal'
             ) THEN 'failed_terminal'
             WHEN EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id = notifications.id
                 AND delivery.state = 'suppressed'
             ) THEN 'suppressed'
            ELSE 'cancelled_superseded'
          END AS preserved_delivery_state
       FROM notifications
       WHERE supersession_key = $2
         AND id <> $1
         AND category = ANY($3::TEXT[])
         AND superseded_at IS NULL
       FOR UPDATE OF notifications
     ), superseded AS (
       UPDATE notifications notification
       SET superseded_at = NOW(),
           superseded_by_notification_id = $1,
           delivery_state = target.preserved_delivery_state,
           terminal_failure_at = CASE
             WHEN target.preserved_delivery_state = 'failed_terminal'
               THEN notification.terminal_failure_at
             ELSE NULL
           END,
           terminal_failure_reason = CASE
             WHEN target.preserved_delivery_state = 'failed_terminal'
               THEN notification.terminal_failure_reason
             ELSE NULL
           END,
           updated_at = NOW()
       FROM supersession_targets target
       WHERE notification.id = target.id
       RETURNING notification.id
     ), cancelled_deliveries AS (
       UPDATE notification_deliveries
       SET state = 'cancelled_superseded', updated_at = NOW()
       WHERE notification_id IN (SELECT id FROM superseded)
         AND state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING notification_id
     ), cancelled_email AS (
       UPDATE email_outbox
       SET status = 'suppressed', suppressed_reason = 'superseded', suppressed_at = NOW()
       WHERE notification_id IN (SELECT id FROM superseded)
         AND status IN ('pending','failed')
       RETURNING notification_id
     ), cancelled_sms AS (
       UPDATE sms_outbox
       SET status = 'suppressed', error_message = 'superseded', updated_at = NOW()
       WHERE notification_id IN (SELECT id FROM superseded)
         AND status IN ('pending','failed')
       RETURNING notification_id
     ), cancelled_outbox AS (
       UPDATE outbox_events
       SET status = 'processed', processed_at = NOW(), error_message = 'superseded'
       WHERE aggregate_id IN (SELECT id FROM superseded)
         AND status = 'pending'
       RETURNING aggregate_id
     )
     SELECT COUNT(*)::TEXT AS superseded_count FROM superseded`,
    [notificationId, supersessionKey, [...categories]],
  );
}

/**
 * Batch notification with existing notification when frequency limit exceeded
 * NOTIFICATION_SPEC.md §2.2: Batching for rate limiting
 * 
 * When hourly limit is exceeded, batch the new notification with the most recent
 * notification of the same category by updating its metadata to include batched items.
 */
async function batchNotification(
  userId: string,
  category: NotificationCategory,
  notificationData: {
    title: string;
    body: string;
    deepLink: string;
    taskId?: string | null;
    metadata?: Record<string, unknown>;
    priority: NotificationPriority;
    dedupeKey: string;
    objectRef: NotificationObjectReference;
  }
): Promise<ServiceResult<Notification>> {
  try {
    // BUG FIX: Previously the "find most recent notification" SELECT ran
    // outside the transaction. Between that SELECT and the inner FOR UPDATE
    // a concurrent insert could add a newer notification, causing the batch to
    // update a stale older row. Fix: move the search inside the transaction and
    // lock the chosen row atomically with FOR UPDATE from the start.
    const updateResult = await db.transaction(async (txQuery) => {
      // The same recipient lock used by the frequency decision serializes the
      // rollback-and-batch path. A concurrent exact retry must observe either
      // the committed batch marker or the state immediately before it.
      if (!await lockNotificationRecipientAndDedupe(
        userId,
        notificationData.dedupeKey,
        txQuery,
      )) {
        return { kind: 'recipient_missing' as const };
      }

      const replay = await resolveNotificationReplay(
        notificationData.dedupeKey,
        userId,
        category,
        notificationData.objectRef,
        txQuery,
      );
      if (replay.kind === 'match') {
        return { kind: 'accepted' as const, notification: replay.notification };
      }
      if (replay.kind === 'conflict') {
        return { kind: 'dedupe_conflict' as const };
      }

      // Find AND lock the most recent notification atomically
      const lockedResult = await txQuery<Notification>(
        `SELECT * FROM notifications
         WHERE user_id = $1 AND category = $2
           AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [userId, category]
      );

      if (lockedResult.rows.length === 0) {
        return { kind: 'missing_target' as const };
      }

      const existingNotification = lockedResult.rows[0];

      // Update existing notification metadata to include batched item
      const existingMetadata = existingNotification.metadata
        && typeof existingNotification.metadata === 'object'
        && !Array.isArray(existingNotification.metadata)
        ? existingNotification.metadata
        : {};
      const storedBatchedItems = Array.isArray(existingMetadata.batched_items)
        ? existingMetadata.batched_items.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )).map((item) => ({ ...item }))
        : [];
      const storedEvent = storedBatchedItems.find(
        (item) => item.dedupe_key === notificationData.dedupeKey,
      );
      if (storedEvent) {
        return storedEvent.object_type === notificationData.objectRef.type
          && storedEvent.object_id === notificationData.objectRef.id
          ? { kind: 'accepted' as const, notification: existingNotification }
          : { kind: 'dedupe_conflict' as const };
      }

      // Add current notification to batched items
      const batchedItems = [...storedBatchedItems, {
        dedupe_key: notificationData.dedupeKey,
        object_type: notificationData.objectRef.type,
        object_id: notificationData.objectRef.id,
        title: notificationData.title,
        body: notificationData.body,
        deepLink: notificationData.deepLink,
        taskId: notificationData.taskId || undefined,
        metadata: notificationData.metadata || {},
        priority: notificationData.priority,
        timestamp: new Date().toISOString(),
      }];

      // Update notification with batched items
      const updatedMetadata = {
        ...existingMetadata,
        batched_items: batchedItems,
        batched_count: batchedItems.length,
        last_batched_at: new Date().toISOString(),
      };

      // Update notification title/body to reflect batching.
      // BUG FIX: batchedItems already contains the new item (pushed above), so
      // batchedItems.length is the correct total. The previous code added +1
      // again, inflating the count by 1. Similarly, "Plus N more" must be
      // length-1 because the first item is represented by the base notification.
      const baseTitle = existingNotification.title.replace(/ [(]\d+ new[)]$/, '');
      const baseBody = existingNotification.body.replace(/\n\nPlus \d+ more notification.*$/s, '');
      const updatedTitle = `${baseTitle} (${batchedItems.length} new)`;
      const updatedBody = `${baseBody}\n\nPlus ${batchedItems.length - 1} more ${category} notification(s)`;

      const updated = await txQuery<Notification>(
        `UPDATE notifications
         SET title = $1, body = $2, metadata = $3::JSONB, updated_at = NOW()
         WHERE id = $4
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(metadata->'batched_items') = 'array'
                   THEN metadata->'batched_items'
                 ELSE '[]'::JSONB
               END
             ) AS batched_item
             WHERE batched_item->>'dedupe_key' = $5
           )
         RETURNING *`,
        [
          updatedTitle,
          updatedBody,
          JSON.stringify(updatedMetadata),
          existingNotification.id,
          notificationData.dedupeKey,
        ],
      );
      if (updated.rows.length > 0) {
        return { kind: 'accepted' as const, notification: updated.rows[0] };
      }

      const updateReplay = await resolveNotificationReplay(
        notificationData.dedupeKey,
        userId,
        category,
        notificationData.objectRef,
        txQuery,
      );
      return updateReplay.kind === 'match'
        ? { kind: 'accepted' as const, notification: updateReplay.notification }
        : { kind: 'dedupe_conflict' as const };
    });

    if (updateResult.kind === 'recipient_missing' || updateResult.kind === 'missing_target') {
      // No recent notification found to batch with (detected inside transaction)
      return {
        success: false,
        error: {
          code: 'NO_BATCH_TARGET',
          message: 'No recent notification found to batch with',
        },
      };
    }
    if (updateResult.kind === 'dedupe_conflict') {
      return {
        success: false,
        error: {
          code: 'DEDUPE_CONFLICT',
          message: 'Notification deduplication key conflicts with a different batched event identity',
        },
      };
    }

    return {
      success: true,
      data: updateResult.notification,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

/**
 * Find a groupable notification for grouping
 * NOTIFICATION_SPEC.md §2.3: Notification grouping
 * 
 * Groups similar notifications within 5 minutes, max 5 per group.
 * Similar notifications are those with the same category and (optionally) task_id.
 */
async function findGroupableNotification(
  userId: string,
  category: NotificationCategory,
  taskId?: string | null,
  query: QueryFn = db.query,
): Promise<ServiceResult<{ groupId: string; groupPosition: number } | null>> {
  try {
    // Find notifications of the same category within the last 5 minutes
    // If taskId is provided, only group with notifications for the same task
    const groupQuery = taskId
      ? `SELECT group_id, MAX(group_position) as max_position, COUNT(*) as group_size
         FROM notifications
         WHERE user_id = $1 AND category = $2 AND task_id = $3
         AND created_at > NOW() - INTERVAL '5 minutes'
         AND group_id IS NOT NULL
         GROUP BY group_id
         ORDER BY MAX(group_position) DESC
         LIMIT 1`
      : `SELECT group_id, MAX(group_position) as max_position, COUNT(*) as group_size
         FROM notifications
         WHERE user_id = $1 AND category = $2
         AND created_at > NOW() - INTERVAL '5 minutes'
         AND group_id IS NOT NULL
         GROUP BY group_id
         ORDER BY MAX(group_position) DESC
         LIMIT 1`;
    
    const params = taskId ? [userId, category, taskId] : [userId, category];
    const groupResult = await query<{ group_id: string; max_position: number; group_size: string }>(
      groupQuery,
      params
    );
    
    if (groupResult.rows.length > 0) {
      const group = groupResult.rows[0];
      const groupSize = parseInt(group.group_size, 10);
      
      // If group is not full (max 5), add to existing group
      if (groupSize < 5) {
        return {
          success: true,
          data: {
            groupId: group.group_id,
            groupPosition: group.max_position + 1, // Next position: MAX(group_position)+1 to avoid duplicates if items were deleted
          },
        };
      }
    }
    
    // No groupable notification found or all groups are full - create new group
    // Return null to indicate new group should be created (UUID generated on insert)
    return {
      success: true,
      data: null, // New group will be created with new UUID
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS - NOTIFICATION QUEUING (PHASE C: WRITE-ONLY)
// ============================================================================

/**
 * Queue notification via specified channels using outbox pattern
 * PHASE C: This method ONLY writes to email_outbox + outbox_events
 * NO INLINE SENDS - All external channel delivery is async via workers
 * 
 * NOTIFICATION_SPEC.md §2.4: Multi-channel delivery
 * 
 * Hard rule: No service sends email/push/SMS inline. All delivery goes through outbox.
 */
async function queueNotificationChannels(
  notification: Notification,
  channels: NotificationChannel[],
  availableAt: Date,
  deferredForQuietHours: boolean,
  deferredForFocus: boolean,
  query: QueryFn = db.query,
): Promise<Notification> {
  const initialExternalState = deferredForFocus
    ? 'deferred_focus'
    : deferredForQuietHours
      ? 'deferred_quiet_hours'
      : 'pending';
  await query(
    `INSERT INTO notification_deliveries (
       notification_id, channel, state, max_attempts, available_at,
       provider_accepted_at, delivered_at
     )
     SELECT $1, channel,
            CASE WHEN channel = 'in_app' THEN 'delivered' ELSE $3 END,
            3, CASE WHEN channel = 'in_app' THEN NOW() ELSE $4 END,
            CASE WHEN channel = 'in_app' THEN NOW() ELSE NULL END,
            CASE WHEN channel = 'in_app' THEN NOW() ELSE NULL END
     FROM unnest($2::TEXT[]) AS channel
     ON CONFLICT (notification_id, channel) DO NOTHING`,
    [notification.id, channels, initialExternalState, availableAt],
  );

  const externalChannels = channels.filter((channel) => channel !== 'in_app');
  const failedChannels: NotificationChannel[] = [];
  // One PostgreSQL transaction owns these writes. Run channel writers in a
  // deterministic sequence rather than issuing concurrent commands on one client.
  for (const channel of externalChannels) {
    const savepoint = `notification_channel_${channel}`;
    await query(`SAVEPOINT ${savepoint}`);
    try {
      if (channel === 'email') await queueEmailNotification(notification, availableAt, query);
      else if (channel === 'push') await queuePushNotification(notification, availableAt, query);
      else await queueSMSNotification(notification, availableAt, query);
      await query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      // A PostgreSQL statement error aborts work back to the nearest savepoint.
      // Roll back that channel before recording its durable retry intent; if
      // savepoint recovery itself fails, propagate and roll back acceptance.
      try {
        await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (savepointError) {
        throw new AggregateError(
          [error, savepointError],
          `Notification channel ${channel} savepoint recovery failed`,
        );
      }
      failedChannels.push(channel);
      log.error({
        err: error instanceof Error ? error.message : String(error),
        notificationId: notification.id,
        channel,
      }, 'Failed to queue notification channel; persisted for bounded recovery');
    }
  }

  for (const channel of failedChannels) {
    await query(
      `UPDATE notification_deliveries
       SET state = 'retry_pending',
           attempt_count = LEAST(attempt_count + 1, max_attempts),
           next_retry_at = NOW() + INTERVAL '1 minute',
           last_error = 'outbox_queue_failed',
           updated_at = NOW()
       WHERE notification_id = $1 AND channel = $2`,
      [notification.id, channel],
    );
  }

  const queuedCount = externalChannels.length - failedChannels.length;
  const hasInApp = channels.includes('in_app');
  const aggregateState = failedChannels.length > 0
    ? (queuedCount > 0 || hasInApp ? 'partially_queued' : 'retry_pending')
    : deferredForFocus && externalChannels.length > 0
      ? 'deferred_focus'
      : deferredForQuietHours && externalChannels.length > 0
      ? 'deferred_quiet_hours'
      : externalChannels.length > 0
        ? 'queued'
        : 'delivered';

  const canonical = await query<Notification>(
    `UPDATE notifications
     SET sent_at = CASE WHEN $2::INTEGER > 0 OR $3::BOOLEAN THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
         delivered_at = CASE WHEN $3::BOOLEAN THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
         delivery_state = $4,
         delivery_attempts = LEAST(delivery_attempts + $5::INTEGER, 5),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [notification.id, queuedCount, hasInApp, aggregateState, failedChannels.length],
  );
  const persisted = canonical.rows[0];
  if (!persisted) {
    throw new Error(`Notification ${notification.id} disappeared before queue-state persistence`);
  }
  return persisted;
}

/**
 * Queue email notification via email_outbox + outbox pattern
 * PHASE C: Write-only method - creates email_outbox row + outbox_event in same transaction
 * 
 * Hard rule: NO INLINE SENDS - email worker is the ONLY sender
 * 
 * @param notification Notification to email
 * @returns email_id from email_outbox table
 */
async function queueEmailNotification(
  notification: Notification,
  availableAt: Date,
  transactionQuery?: QueryFn,
): Promise<void> {
  const query = transactionQuery ?? db.query;
  // Get user's email address (required for email_outbox)
  const userResult = await query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [notification.user_id]
  );
  
  if (userResult.rows.length === 0) {
    throw new Error(`User ${notification.user_id} not found`);
  }
  
  const userEmail = userResult.rows[0].email;
  
  if (!userEmail) {
    throw new Error(`User ${notification.user_id} has no email address`);
  }
  
  // Map notification category to email template
  const templateMap: Record<string, string> = {
    'task_accepted': 'task_status_changed',
    'task_completed': 'task_status_changed',
    'task_cancelled': 'task_status_changed',
    'task_expired': 'task_status_changed',
    'proof_submitted': 'task_status_changed',
    'proof_approved': 'task_status_changed',
    'proof_rejected': 'task_status_changed',
    'payment_released': 'payment_released',
    'payment_due': 'notification',
    'refund_issued': 'task_status_changed',
    'escrow_funded': 'task_status_changed',
    'dispute_opened': 'task_status_changed',
    'dispute_resolved': 'task_status_changed',
    'account_suspended': 'security_alert',
    'security_alert': 'security_alert',
    'password_changed': 'security_alert',
    'export_ready': 'export_ready',
    'welcome': 'welcome',
    'weekly_recap': 'notification',
    'trust_tier_upgraded': 'notification',
    'badge_earned': 'notification',
  };
  
  const template = templateMap[notification.category] || 'notification'; // Default template
  const params = {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    deepLink: notification.deep_link,
    category: notification.category,
    taskId: notification.task_id,
    metadata: notification.metadata || {},
  };
  
  // Generate deterministic idempotency key
  // Channel idempotency is notification-scoped. Event-level deduplication happens
  // before this writer; using task_id here would collapse distinct lifecycle events
  // that share the same email template.
  const idempotencyKey = `email.send_requested:${template}:${userEmail}:${notification.id}:1`;
  
  // Create email_outbox row + outbox_event in the caller's transaction when
  // notification acceptance is still pending; retries open their own one.
  const writeEmailOutbox = async (writeQuery: QueryFn): Promise<void> => {
    // Create email_outbox row (status='pending')
    const emailResult = await writeQuery<{ id: string }>(
      `INSERT INTO email_outbox (
        user_id, to_email, template, params_json, priority, status, idempotency_key,
        notification_id, available_at
      ) VALUES ($1, $2, $3, $4::JSONB, $5, 'pending', $6, $7, $8)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        updated_at = NOW(), available_at = LEAST(email_outbox.available_at, EXCLUDED.available_at)
      RETURNING id`,
      [
        notification.user_id,
        userEmail,
        template,
        JSON.stringify(params),
        notification.priority,
        idempotencyKey,
        notification.id,
        availableAt,
      ]
    );
    
    const emailId = emailResult.rows[0].id;
    
    // Write outbox_event (email.send_requested) in same transaction
    // Check for duplicate (idempotency key must be unique)
    const existingOutbox = await writeQuery(
      `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    
    if (existingOutbox.rows.length === 0) {
      await writeQuery(
        `INSERT INTO outbox_events (
          event_type, aggregate_type, aggregate_id, event_version,
          idempotency_key, payload, queue_name, status, available_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [
          'email.send_requested',
          'email',
          emailId,
          1,
          idempotencyKey,
          JSON.stringify({
            emailId,
            userId: notification.user_id,
            toEmail: userEmail,
            template,
            params,
          }),
          'user_notifications',
          availableAt,
        ]
      );
    }
    
  };
  if (transactionQuery) await writeEmailOutbox(transactionQuery);
  else await db.transaction(writeEmailOutbox);
  
  // Email queued successfully (will be processed by email worker)
  log.info({ notificationId: notification.id, userId: notification.user_id, template, channel: 'email' }, 'Email notification queued');
}

/**
 * Queue push notification via outbox pattern
 * PHASE C: Write-only method - creates outbox_event for push-worker to process
 *
 * Hard rule: NO INLINE SENDS - push worker is the ONLY sender
 *
 * @param notification Notification to push
 */
async function queuePushNotification(
  notification: Notification,
  availableAt: Date,
  query: QueryFn = db.query,
): Promise<void> {
  // Build data payload from notification metadata
  const data: Record<string, string> = {
    notificationId: notification.id,
    category: notification.category,
    deepLink: notification.deep_link,
  };

  if (notification.task_id) {
    data.taskId = notification.task_id;
  }

  // Generate deterministic idempotency key.
  // BUG FIX: Previously used task_id as the stable part, which collapsed all
  // push notifications for the same (user, category, task) into a single key.
  // Only the first push was ever delivered; all subsequent ones were silently
  // dropped by ON CONFLICT DO NOTHING. Using notification.id (unique per
  // notification) ensures each notification gets its own push while still
  // providing retry deduplication (same notification.id on retry = same key).
  const idempotencyKey = `push.send_requested:${notification.category}:${notification.user_id}:${notification.id}:1`;

  // Write outbox_event (push.send_requested) — ON CONFLICT DO NOTHING for idempotency.
  // A single atomic INSERT eliminates the racy SELECT+INSERT pattern: two concurrent
  // callers with the same idempotency_key will both attempt the INSERT but only one
  // will produce a row; the other gets rowCount === 0 and returns early.
  const insertResult = await query(
    `INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, event_version,
      idempotency_key, payload, queue_name, status, available_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      'push.send_requested',
      'push',
      notification.id,
      1,
      idempotencyKey,
      JSON.stringify({
        notificationId: notification.id,
        userId: notification.user_id,
        title: notification.title,
        body: notification.body,
        data,
      }),
      'user_notifications',
      availableAt,
    ]
  );

  if ((insertResult.rowCount ?? 0) === 0) {
    // Already queued - skip (idempotent)
    return;
  }

  // Push queued successfully (will be processed by push worker)
  log.info({ notificationId: notification.id, userId: notification.user_id, channel: 'push' }, 'Push notification queued');
}

/**
 * Queue SMS notification via sms_outbox + outbox pattern
 * Write-only method - creates sms_outbox row + outbox_event in same transaction
 *
 * Hard rule: NO INLINE SENDS - SMS worker is the ONLY sender
 *
 * @param notification Notification to SMS
 */
async function queueSMSNotification(
  notification: Notification,
  availableAt: Date,
  transactionQuery?: QueryFn,
): Promise<void> {
  const query = transactionQuery ?? db.query;
  // Get user's phone number (required for sms_outbox)
  const userResult = await query<{ phone: string }>(
    `SELECT phone FROM users WHERE id = $1`,
    [notification.user_id]
  );

  if (userResult.rows.length === 0) {
    throw new Error(`User ${notification.user_id} not found`);
  }

  const userPhone = userResult.rows[0].phone;

  if (!userPhone) {
    throw new Error(`User ${notification.user_id} has no SMS destination`);
  }

  // Build SMS body from notification
  const smsBody = `${notification.title}: ${notification.body}`;

  // Generate deterministic idempotency key
  // Notification identity preserves distinct lifecycle events for the same task;
  // retries of this notification still converge on the same key.
  const idempotencyKey = `sms.send_requested:${notification.category}:${userPhone}:${notification.id}:1`;

  // Create sms_outbox row + outbox_event in the caller's transaction when
  // notification acceptance is still pending; retries open their own one.
  const writeSmsOutbox = async (writeQuery: QueryFn): Promise<void> => {
    // Create sms_outbox row (status='pending')
    const smsResult = await writeQuery<{ id: string }>(
      `INSERT INTO sms_outbox (
        user_id, to_phone, body, priority, status, idempotency_key,
        notification_id, available_at
      ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        updated_at = NOW(), available_at = LEAST(sms_outbox.available_at, EXCLUDED.available_at)
      RETURNING id`,
      [
        notification.user_id,
        userPhone,
        smsBody,
        notification.priority,
        idempotencyKey,
        notification.id,
        availableAt,
      ]
    );

    const smsId = smsResult.rows[0].id;

    // Write outbox_event (sms.send_requested) in same transaction
    // Check for duplicate (idempotency key must be unique)
    const existingOutbox = await writeQuery(
      `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );

    if (existingOutbox.rows.length === 0) {
      await writeQuery(
        `INSERT INTO outbox_events (
          event_type, aggregate_type, aggregate_id, event_version,
          idempotency_key, payload, queue_name, status, available_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [
          'sms.send_requested',
          'sms',
          smsId,
          1,
          idempotencyKey,
          JSON.stringify({
            smsId,
            notificationId: notification.id,
            userId: notification.user_id,
            toPhone: userPhone,
            body: smsBody,
          }),
          'user_notifications',
          availableAt,
        ]
      );
    }

  };
  if (transactionQuery) await writeSmsOutbox(transactionQuery);
  else await db.transaction(writeSmsOutbox);

  // SMS queued successfully (will be processed by SMS worker)
  log.info({ notificationId: notification.id, userId: notification.user_id, phone: userPhone.slice(0, 4) + '****', channel: 'sms' }, 'SMS notification queued');
}
