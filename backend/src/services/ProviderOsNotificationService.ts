/**
 * ProviderOsNotificationService
 *
 * Provider OS domain event → durable notification ledger → sms_outbox → Twilio worker.
 *
 * Guarantees:
 * - Twilio is never called inline on request paths
 * - Emit failures never throw to callers (side effect only)
 * - Idempotent on (event_type, provider_user_id, entity_type, entity_id)
 * - Recipient resolved from Provider OS relationship / quote claim, not frontend
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'ProviderOsNotificationService' });

export const PROVIDER_OS_NOTIFICATION_EVENTS = [
  'CLIENT_ONBOARDED',
  'CLIENT_TASK_CREATED',
  'PROVIDER_QUOTE_APPROVED',
  'TASK_PAYMENT_CONFIRMED',
] as const;

export type ProviderOsNotificationEventType =
  (typeof PROVIDER_OS_NOTIFICATION_EVENTS)[number];

export type ProviderOsNotificationEntityType =
  | 'relationship'
  | 'task_draft'
  | 'quote'
  | 'task';

export interface ProviderOsNotificationEmitInput {
  eventType: ProviderOsNotificationEventType;
  providerUserId: string;
  posterUserId?: string | null;
  entityType: ProviderOsNotificationEntityType;
  entityId: string;
  messageBody: string;
}

export interface ProviderOsNotificationEmitResult {
  emitted: boolean;
  reason?: 'duplicate' | 'no_phone' | 'queued' | 'error';
  eventId?: string;
}

function smsIdempotencyKey(input: ProviderOsNotificationEmitInput): string {
  return `provider_os:${input.eventType}:${input.providerUserId}:${input.entityType}:${input.entityId}`;
}

/**
 * Persist + enqueue one Provider OS SMS. Safe to call after domain success.
 * Never throws.
 */
export async function emitProviderOsNotification(
  input: ProviderOsNotificationEmitInput,
): Promise<ProviderOsNotificationEmitResult> {
  try {
    const body = input.messageBody.trim();
    if (!body) {
      return { emitted: false, reason: 'error' };
    }

    const phoneResult = await db.query<{ phone: string | null }>(
      `SELECT phone FROM users WHERE id = $1`,
      [input.providerUserId],
    );
    const phone = phoneResult.rows[0]?.phone?.trim() ?? null;

    if (!phone) {
      await db.query(
        `INSERT INTO provider_os_notification_events (
           event_type, provider_user_id, poster_user_id,
           entity_type, entity_id, message_body, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'skipped_no_phone')
         ON CONFLICT (event_type, provider_user_id, entity_type, entity_id)
         DO NOTHING`,
        [
          input.eventType,
          input.providerUserId,
          input.posterUserId ?? null,
          input.entityType,
          input.entityId,
          body,
        ],
      );
      log.info(
        { eventType: input.eventType, providerUserId: input.providerUserId },
        'provider_os_notification_skipped_no_phone',
      );
      return { emitted: false, reason: 'no_phone' };
    }

    const idempotencyKey = smsIdempotencyKey(input);

    const queued = await db.transaction(async (query) => {
      const inserted = await query<{ id: string }>(
        `INSERT INTO provider_os_notification_events (
           event_type, provider_user_id, poster_user_id,
           entity_type, entity_id, message_body, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued')
         ON CONFLICT (event_type, provider_user_id, entity_type, entity_id)
         DO NOTHING
         RETURNING id`,
        [
          input.eventType,
          input.providerUserId,
          input.posterUserId ?? null,
          input.entityType,
          input.entityId,
          body,
        ],
      );

      const eventId = inserted.rows[0]?.id;
      if (!eventId) {
        return { emitted: false as const, reason: 'duplicate' as const };
      }

      const smsResult = await query<{ id: string }>(
        `INSERT INTO sms_outbox (
           user_id, to_phone, body, priority, status, idempotency_key, available_at
         ) VALUES ($1, $2, $3, 'HIGH', 'pending', $4, NOW())
         ON CONFLICT (idempotency_key) DO UPDATE SET
           updated_at = NOW(),
           available_at = LEAST(sms_outbox.available_at, EXCLUDED.available_at)
         RETURNING id`,
        [input.providerUserId, phone, body, idempotencyKey],
      );

      const smsId = smsResult.rows[0]?.id;
      if (!smsId) {
        throw new Error('SMS_OUTBOX_INSERT_FAILED');
      }

      await writeToOutbox(
        {
          eventType: 'sms.send_requested',
          aggregateType: 'sms',
          aggregateId: smsId,
          eventVersion: 1,
          queueName: 'user_notifications',
          idempotencyKey,
          payload: {
            smsId,
            userId: input.providerUserId,
            to: phone,
            source: 'provider_os',
            eventType: input.eventType,
            eventId,
          },
        },
        query,
      );

      return { emitted: true as const, reason: 'queued' as const, eventId };
    });

    if (queued.emitted) {
      log.info(
        {
          eventType: input.eventType,
          providerUserId: input.providerUserId,
          entityId: input.entityId,
          eventId: queued.eventId,
        },
        'provider_os_notification_queued',
      );
    }

    return queued;
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        eventType: input.eventType,
        providerUserId: input.providerUserId,
        entityId: input.entityId,
      },
      'provider_os_notification_emit_failed_non_fatal',
    );
    return { emitted: false, reason: 'error' };
  }
}

export function buildProviderOsMessage(
  eventType: ProviderOsNotificationEventType,
  ctx: {
    posterName: string;
    taskTitle?: string | null;
  },
): string {
  const name = (ctx.posterName || 'Your client').trim() || 'Your client';
  const title = (ctx.taskTitle || 'a new task').trim() || 'a new task';

  switch (eventType) {
    case 'CLIENT_ONBOARDED':
      return `${name} has successfully joined HustleXP through your Provider OS onboarding link.`;
    case 'CLIENT_TASK_CREATED':
      return `${name} posted a new task: "${title}". Open Provider OS to review and quote it.`;
    case 'PROVIDER_QUOTE_APPROVED':
      return `${name} approved your quote for "${title}".`;
    case 'TASK_PAYMENT_CONFIRMED':
      return `Payment has been confirmed for "${title}". The task is ready to proceed.`;
    default: {
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}
