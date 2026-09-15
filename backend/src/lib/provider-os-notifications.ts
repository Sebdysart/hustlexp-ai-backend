/**
 * Provider OS notification hooks — fire-and-forget after successful domain events.
 * Never block or fail onboarding / task create / quote / payment paths.
 */

import { db } from '../db.js';
import { isProviderOsEligibleDraft } from '../services/ProviderOsPolicy.js';
import {
  buildProviderOsMessage,
  emitProviderOsNotification,
} from '../services/ProviderOsNotificationService.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'provider-os-notifications' });

async function loadUserName(userId: string): Promise<string> {
  const result = await db.query<{ full_name: string }>(
    `SELECT full_name FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.full_name?.trim() || 'Your client';
}

/** After Provider OS invite accept / relationship upsert succeeds. */
export async function notifyProviderOsClientOnboarded(input: {
  providerUserId: string;
  posterUserId: string;
  relationshipId: string;
}): Promise<void> {
  try {
    const posterName = await loadUserName(input.posterUserId);
    await emitProviderOsNotification({
      eventType: 'CLIENT_ONBOARDED',
      providerUserId: input.providerUserId,
      posterUserId: input.posterUserId,
      entityType: 'relationship',
      entityId: input.relationshipId,
      messageBody: buildProviderOsMessage('CLIENT_ONBOARDED', { posterName }),
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), ...input },
      'notifyProviderOsClientOnboarded failed (non-fatal)',
    );
  }
}

/** After poster creates a new task draft — fan-out to all active Provider OS providers. */
export async function notifyProviderOsProvidersOfNewDraft(input: {
  posterUserId: string;
  draftId: string;
}): Promise<void> {
  try {
    const draft = await db.query<{
      id: string;
      title: string | null;
      status: string;
      claimed_at: Date | null;
      task_id: string | null;
      quote_id: string | null;
      poster_user_id: string | null;
    }>(
      `SELECT id, title, status, claimed_at, task_id, quote_id, poster_user_id
         FROM task_drafts
        WHERE id = $1`,
      [input.draftId],
    );
    const row = draft.rows[0];
    if (!row) return;

    if (!isProviderOsEligibleDraft({
      status: row.status,
      claimedAt: row.claimed_at,
      taskId: row.task_id,
      posterUserId: row.poster_user_id,
      quoteId: row.quote_id,
    })) {
      return;
    }

    const providers = await db.query<{ provider_user_id: string }>(
      `SELECT provider_user_id
         FROM provider_os_relationships
        WHERE poster_user_id = $1
          AND status = 'active'`,
      [input.posterUserId],
    );

    if (providers.rows.length === 0) return;

    const posterName = await loadUserName(input.posterUserId);
    const taskTitle = row.title ?? 'Untitled request';

    await Promise.all(
      providers.rows.map((provider) => emitProviderOsNotification({
        eventType: 'CLIENT_TASK_CREATED',
        providerUserId: provider.provider_user_id,
        posterUserId: input.posterUserId,
        entityType: 'task_draft',
        entityId: input.draftId,
        messageBody: buildProviderOsMessage('CLIENT_TASK_CREATED', {
          posterName,
          taskTitle,
        }),
      })),
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), ...input },
      'notifyProviderOsProvidersOfNewDraft failed (non-fatal)',
    );
  }
}

/**
 * Poster accepted a Provider OS quote (started payment / committed to pay).
 * Only notifies when the quote was created through Provider OS / business claim binding.
 */
export async function notifyProviderOsQuoteApproved(input: {
  quoteId: string;
  posterUserId: string;
}): Promise<void> {
  try {
    const quote = await db.query<{
      id: string;
      claimed_by_user_id: string | null;
      title: string | null;
      poster_user_id: string | null;
      scope_json: Record<string, unknown> | null;
    }>(
      `SELECT q.id,
              q.claimed_by_user_id,
              q.title,
              d.poster_user_id,
              qv.scope_json
         FROM quotes q
         JOIN task_drafts d ON d.id = q.task_draft_id
         LEFT JOIN quote_versions qv ON qv.id = q.active_version_id
        WHERE q.id = $1`,
      [input.quoteId],
    );
    const row = quote.rows[0];
    if (!row?.claimed_by_user_id) return;

    const scope = row.scope_json ?? {};
    const isProviderOs =
      scope.provider_os === true
      || scope.claim_entry === 'provider_os';
    if (!isProviderOs) return;

    const rel = await db.query<{ id: string }>(
      `SELECT id FROM provider_os_relationships
        WHERE provider_user_id = $1
          AND poster_user_id = $2
          AND status = 'active'
        LIMIT 1`,
      [row.claimed_by_user_id, row.poster_user_id],
    );
    if (!rel.rows[0]) return;

    const posterName = await loadUserName(input.posterUserId);
    await emitProviderOsNotification({
      eventType: 'PROVIDER_QUOTE_APPROVED',
      providerUserId: row.claimed_by_user_id,
      posterUserId: input.posterUserId,
      entityType: 'quote',
      entityId: input.quoteId,
      messageBody: buildProviderOsMessage('PROVIDER_QUOTE_APPROVED', {
        posterName,
        taskTitle: row.title,
      }),
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), ...input },
      'notifyProviderOsQuoteApproved failed (non-fatal)',
    );
  }
}

/** Payment finalized successfully for a Provider OS quote. */
export async function notifyProviderOsPaymentConfirmed(input: {
  quoteId: string;
  taskId: string;
  posterUserId: string;
  replayed?: boolean;
}): Promise<void> {
  try {
    if (input.replayed) return;

    const quote = await db.query<{
      id: string;
      claimed_by_user_id: string | null;
      title: string | null;
      poster_user_id: string | null;
      scope_json: Record<string, unknown> | null;
    }>(
      `SELECT q.id,
              q.claimed_by_user_id,
              q.title,
              d.poster_user_id,
              qv.scope_json
         FROM quotes q
         JOIN task_drafts d ON d.id = q.task_draft_id
         LEFT JOIN quote_versions qv ON qv.id = q.active_version_id
        WHERE q.id = $1`,
      [input.quoteId],
    );
    const row = quote.rows[0];
    if (!row?.claimed_by_user_id) return;

    const scope = row.scope_json ?? {};
    const isProviderOs =
      scope.provider_os === true
      || scope.claim_entry === 'provider_os';
    if (!isProviderOs) return;

    const rel = await db.query<{ id: string }>(
      `SELECT id FROM provider_os_relationships
        WHERE provider_user_id = $1
          AND poster_user_id = $2
          AND status = 'active'
        LIMIT 1`,
      [row.claimed_by_user_id, row.poster_user_id],
    );
    if (!rel.rows[0]) return;

    const posterName = await loadUserName(input.posterUserId);
    await emitProviderOsNotification({
      eventType: 'TASK_PAYMENT_CONFIRMED',
      providerUserId: row.claimed_by_user_id,
      posterUserId: input.posterUserId,
      entityType: 'task',
      entityId: input.taskId,
      messageBody: buildProviderOsMessage('TASK_PAYMENT_CONFIRMED', {
        posterName,
        taskTitle: row.title,
      }),
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), ...input },
      'notifyProviderOsPaymentConfirmed failed (non-fatal)',
    );
  }
}
