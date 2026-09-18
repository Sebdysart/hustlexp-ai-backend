/** Provider OS SMS is deliberately disabled during the organization migration.
 * Message templates remain for the later durable organization notification pass. */

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
  reason?: 'disabled' | 'duplicate' | 'no_phone' | 'queued' | 'error';
  eventId?: string;
}

/** Disabled until organization ownership, recipient membership, preferences and
 * durable event provenance are carried end-to-end. Never enqueue user-owned SMS. */
export async function emitProviderOsNotification(
  _input: ProviderOsNotificationEmitInput,
): Promise<ProviderOsNotificationEmitResult> {
  return { emitted: false, reason: 'disabled' };
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
