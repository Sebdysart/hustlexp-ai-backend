import { db, type QueryFn } from '../db.js';
import { nextQuietHoursEnd } from './NotificationPolicy.js';
import { NotificationService } from './NotificationService.js';

export const PREMIUM_EVENTS = ['CLIENT_JOINED', 'CLIENT_TASK_POSTED', 'QUOTE_ACCEPTED', 'TASK_READY'] as const;
export interface PremiumEvent {
  id: string;
  event_type: (typeof PREMIUM_EVENTS)[number];
  organization_id: string | null;
  poster_user_id: string | null;
  relationship_id: string | null;
  draft_id: string | null;
  quote_id: string | null;
  task_id: string | null;
  status: string;
}

export function premiumDestination(event: PremiumEvent): string {
  const org = `organizationId=${event.organization_id}`;
  switch (event.event_type) {
    case 'CLIENT_JOINED': return `/provider-os?${org}`;
    case 'CLIENT_TASK_POSTED': return `/provider-os/drafts/${event.draft_id}?${org}`;
    case 'QUOTE_ACCEPTED': return `/provider-os/quotes/${event.quote_id}?${org}`;
    case 'TASK_READY': return `/business/tasks/${event.task_id}`;
  }
}

export function premiumMessage(type: PremiumEvent['event_type']): string {
  switch (type) {
    case 'CLIENT_JOINED': return 'HustleXP: A client has joined your Provider OS workspace.';
    case 'CLIENT_TASK_POSTED': return 'HustleXP: A connected client posted a new request.';
    case 'QUOTE_ACCEPTED': return 'HustleXP: A client accepted your Provider OS quote.';
    case 'TASK_READY': return 'HustleXP: Client payment is confirmed and your job is ready.';
  }
}

export function premiumSmsBody(event: PremiumEvent): string {
  // Same web origin configuration used by canonical action links, never user input.
  const base = new URL(process.env.SITE_URL ?? 'https://hustlexp.app');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('INVALID_PREMIUM_SMS_SITE_URL');
  return `${premiumMessage(event.event_type)} ${base.origin}${premiumDestination(event)}`;
}

export async function loadPremiumEvent(id: string, query: QueryFn = db.query.bind(db)): Promise<PremiumEvent | undefined> {
  return (await query<PremiumEvent>('SELECT * FROM provider_os_domain_events WHERE id = $1', [id])).rows[0];
}

/** Re-read canonical ownership; serialized jobs never confer authority. Deletions fail closed. */
export async function premiumEventEligible(event: PremiumEvent, query: QueryFn): Promise<boolean> {
  const result = await query<{ allowed: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM business_organizations o
      JOIN provider_os_entitlements e ON e.organization_id = o.id
      JOIN provider_os_relationships r ON r.provider_organization_id = o.id AND r.id = $3
      JOIN users client ON client.id = r.poster_user_id
      WHERE o.id = $1 AND o.status = 'ACTIVE' AND o.provider_enabled
        AND e.status = 'active' AND e.starts_at <= NOW() AND (e.expires_at IS NULL OR e.expires_at > NOW())
        AND r.poster_user_id = $2 AND r.status = 'active' AND r.accepted_at IS NOT NULL
        AND client.account_status = 'ACTIVE' AND NOT COALESCE(client.is_banned, false)
        AND NOT COALESCE(client.trust_hold, false)
        AND (
          $4 = 'CLIENT_JOINED'
          OR ($4 = 'CLIENT_TASK_POSTED' AND EXISTS (
            SELECT 1 FROM task_drafts d WHERE d.id = $5 AND d.poster_user_id = $2
              AND d.claimed_at IS NULL AND d.task_id IS NULL AND d.quote_id IS NULL
              AND d.status IN ('draft','anonymous_task_draft','contact_captured','account_claimed','quote_ready','quote_send_ready')
              AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.task_draft_id = d.id AND q.business_organization_id = $1
                AND q.status NOT IN ('rejected','withdrawn','expired','superseded'))))
          OR ($4 IN ('QUOTE_ACCEPTED','TASK_READY') AND EXISTS (
            SELECT 1 FROM quotes q JOIN task_drafts d ON d.id = q.task_draft_id
            WHERE q.id = $6 AND q.business_organization_id = $1 AND q.acquisition_origin = 'provider_os'
              AND d.id = $5 AND d.poster_user_id = $2
              AND ($4 = 'QUOTE_ACCEPTED' OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = $7
                AND t.id = d.task_id AND t.business_fulfiller_organization_id = $1
                AND EXISTS (SELECT 1 FROM quote_payments payment WHERE payment.quote_id = q.id
                  AND payment.task_id = t.id AND payment.status = 'SUCCEEDED')))))
        )
    ) AS allowed`, [event.organization_id, event.poster_user_id, event.relationship_id,
    event.event_type, event.draft_id, event.quote_id, event.task_id]);
  return result.rows[0]?.allowed === true;
}

export interface PremiumRecipient {
  id: string;
  phone: string | null;
  account_status: string;
  is_banned: boolean;
  trust_hold: boolean;
  authorized: boolean;
  sms_enabled: boolean | null;
  quiet_hours_enabled: boolean | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
}

export async function premiumRecipients(event: PremiumEvent, query: QueryFn, userId?: string): Promise<PremiumRecipient[]> {
  const result = await query<PremiumRecipient>(`
    SELECT u.id, u.phone, u.account_status, u.is_banned, u.trust_hold,
      (m.status = 'ACTIVE' AND m.role IN ('OWNER','ADMIN','DISPATCHER')
        AND business_membership_has_action($1, u.id, 'READ_WORKSPACE')
        AND business_membership_has_action($1, u.id, 'ASSIGN_CREW')) AS authorized,
      p.sms_enabled, p.quiet_hours_enabled, p.quiet_hours_start, p.quiet_hours_end, p.quiet_hours_timezone AS timezone
    FROM business_memberships m JOIN users u ON u.id = m.user_id
    LEFT JOIN notification_preferences p ON p.user_id = u.id
    WHERE m.organization_id = $1 AND ($2::uuid IS NULL OR u.id = $2)
      AND ($2::uuid IS NOT NULL OR (m.status = 'ACTIVE' AND m.role IN ('OWNER','ADMIN','DISPATCHER')))
    ORDER BY u.id`, [event.organization_id, userId ?? null]);
  return result.rows;
}

export function recipientSmsPolicy(recipient: PremiumRecipient | undefined, now = new Date()): {
  reason?: string; availableAt?: Date;
} {
  if (!recipient?.authorized) return { reason: 'membership_ineligible' };
  if (recipient.account_status !== 'ACTIVE' || recipient.is_banned || recipient.trust_hold) return { reason: 'account_ineligible' };
  if (recipient.sms_enabled !== true) return { reason: 'sms_not_enabled' };
  if (!recipient.phone || !/^\+[1-9]\d{7,14}$/.test(recipient.phone)) return { reason: 'phone_unusable' };
  try {
    const end = recipient.quiet_hours_enabled !== false
      ? nextQuietHoursEnd(now, recipient.quiet_hours_start ?? '22:00:00', recipient.quiet_hours_end ?? '07:00:00', recipient.timezone ?? 'America/Los_Angeles')
      : null;
    return { availableAt: end ?? now };
  } catch {
    return { reason: 'quiet_hours_invalid' };
  }
}

/** One transaction locks the event and commits fan-out, outcome and acknowledgment.
 * A crash rolls back the fan-out; uniqueness also protects deliberate replay. */
export async function processProviderOsPremiumEvent(eventId: string): Promise<void> {
  await db.transaction(async (query) => {
    const event = (await query<PremiumEvent>('SELECT * FROM provider_os_domain_events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
    if (!event) throw new Error('PREMIUM_EVENT_NOT_FOUND');
    const key = `provider_os:v2:event:${event.id}`;
    if (event.status === 'pending') {
      const eligible = await premiumEventEligible(event, query);
      let queued = 0;
      const recipients = eligible ? await premiumRecipients(event, query) : [];
      for (const recipient of recipients) {
        const policy = recipientSmsPolicy(recipient);
        // Existing quote/payment in-app notices remain authoritative and unchanged.
        if (recipient.authorized && recipient.account_status === 'ACTIVE' && !recipient.is_banned && !recipient.trust_hold
          && ['CLIENT_JOINED', 'CLIENT_TASK_POSTED'].includes(event.event_type)) {
          await NotificationService.createInTransaction(query, {
            userId: recipient.id, type: `PROVIDER_OS_${event.event_type}`, title: 'Provider OS update',
            message: premiumMessage(event.event_type), entityType: 'provider_os_event', entityId: event.id,
            actionUrl: premiumDestination(event), dedupeKey: `${key}:${recipient.id}:in_app`,
          });
        }
        let smsId: string | null = null;
        if (!policy.reason) {
          const smsKey = `provider_os:v2:sms:${event.id}:${recipient.id}`;
          const sms = await query<{ id: string }>(`
            INSERT INTO sms_outbox(user_id, to_phone, body, idempotency_key, provider_os_event_id, available_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id`,
          [recipient.id, recipient.phone, premiumSmsBody(event), smsKey, event.id, policy.availableAt]);
          smsId = sms.rows[0].id;
          await query(`INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, event_version,
            idempotency_key, payload, queue_name, available_at)
            VALUES ('sms.send_requested', 'sms', $1, 2, $2, $3::jsonb, 'user_notifications', $4)
            ON CONFLICT (idempotency_key) DO NOTHING`,
          [smsId, smsKey, JSON.stringify({ smsId }), policy.availableAt]);
          queued++;
        }
        await query(`INSERT INTO provider_os_event_recipients(event_id, user_id, outcome, sms_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT (event_id,user_id) DO NOTHING`,
        [event.id, recipient.id, policy.reason ?? 'queued', smsId]);
      }
      await query(`UPDATE provider_os_domain_events SET status = $2, outcome = $3, processed_at = NOW() WHERE id = $1`,
        [event.id, queued ? 'processed' : 'skipped', !eligible ? 'organization_relationship_or_context_ineligible' : queued ? 'fanout_complete' : 'no_sms_eligible_recipients']);
    }
    await query(`UPDATE outbox_events SET status = 'processed', processed_at = NOW(), error_message = NULL WHERE idempotency_key = $1`, [key]);
  }).catch(async (error: unknown) => {
    // BullMQ retries; the premium dispatch lease also recovers exhausted/lost jobs.
    // Persist the diagnostic on the existing outbox, not in a detached hook.
    try {
      await db.query(`UPDATE outbox_events SET error_message = $2 WHERE idempotency_key = $1 AND status <> 'processed'`,
        [`provider_os:v2:event:${eventId}`, error instanceof Error ? error.message : 'premium_processing_failed']);
    } catch {
      // Preserve the original worker failure if the database is also unavailable.
    }
    throw error;
  });
}
