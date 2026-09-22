import { evaluateBusinessTaskEligibility, persistBusinessQuoteEligibilityDecision } from './BusinessTaskEligibilityService.js';
import type { QueryFn } from '../db.js';
import { NotificationService } from './NotificationService.js';

export const PENDING_BUSINESS_VERIFICATION = 'pending_business_verification' as const;

export async function isBusinessQuoteProviderVerified(query: QueryFn, organizationId: string): Promise<boolean> {
  const result = await query<{ eligible: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM business_organizations
      WHERE id = $1 AND status = 'ACTIVE' AND provider_enabled
        AND verification_status = 'VERIFIED') AS eligible`,
    [organizationId],
  );
  return result.rows[0]?.eligible === true;
}

// Shared by immediate submission and verification release. The caller holds the
// organization and draft locks; updating the expected state is the publish gate.
export async function publishBusinessQuoteInTransaction(
  query: QueryFn,
  input: { quoteId: string; taskDraftId: string; posterUserId: string | null; fromStatus: 'draft' | typeof PENDING_BUSINESS_VERIFICATION },
): Promise<boolean> {
  const published = await query<{ id: string }>(
    `UPDATE quotes q SET status = 'submitted', updated_at = NOW()
     WHERE q.id = $1 AND q.task_draft_id = $2 AND q.status = $3
       AND EXISTS (
         SELECT 1 FROM business_organizations org
         WHERE org.id = q.business_organization_id AND org.status = 'ACTIVE'
           AND org.provider_enabled AND org.verification_status = 'VERIFIED'
       )
     RETURNING q.id`,
    [input.quoteId, input.taskDraftId, input.fromStatus],
  );
  if (!published.rows[0]) return false;

  if (input.posterUserId) await NotificationService.createInTransaction(query, {
    userId: input.posterUserId,
    type: 'QUOTE_RECEIVED',
    title: 'New quote received',
    message: 'A business sent you a quote.',
    entityType: 'quote',
    entityId: input.quoteId,
    actionUrl: `/dashboard/drafts/${input.taskDraftId}`,
    dedupeKey: `quote-created:${input.quoteId}`,
  });
  return true;
}

// Called in the same transaction as admin verification, with the organization
// locked first. Claim submission uses the same lock order so it cannot miss a
// concurrent verification or publish a quote before verification commits.
export async function activatePendingBusinessQuotesInTransaction(
  query: QueryFn,
  organizationId: string,
): Promise<number> {
  const pending = await query<{ id: string; task_draft_id: string }>(
    `SELECT id, task_draft_id FROM quotes
     WHERE business_organization_id = $1 AND status = $2
     ORDER BY task_draft_id, id`,
    [organizationId, PENDING_BUSINESS_VERIFICATION],
  );
  let activated = 0;
  for (const quote of pending.rows) {
    const claim = await query<{ id: string }>(
      `SELECT id FROM ops_business_claim_links
       WHERE quote_id = $1 AND task_draft_id = $2
         AND claimed_by_organization_id = $3 AND status = 'CLAIMED'
       FOR UPDATE`,
      [quote.id, quote.task_draft_id, organizationId],
    );
    const draft = (await query<{
      poster_user_id: string | null; status: string; quote_id: string | null; task_id: string | null;
    }>(
      `SELECT poster_user_id, status, quote_id, task_id FROM task_drafts WHERE id = $1 FOR UPDATE`,
      [quote.task_draft_id],
    )).rows[0];
    const version = (await query<{ eligible: boolean; id: string }>(
      `SELECT qv.id, (qv.status = 'draft' AND qv.expires_at > NOW()
                 AND qv.arrival_window_end > NOW()
                 AND qv.dispatch_expires_at > NOW()) AS eligible
       FROM quotes q JOIN quote_versions qv ON qv.id = q.active_version_id AND qv.quote_id = q.id
       WHERE q.id = $1 AND q.status = $2 FOR UPDATE OF q, qv`,
      [quote.id, PENDING_BUSINESS_VERIFICATION],
    )).rows[0];

    if (!claim.rows[0] || !draft || draft.status === 'abandoned' || draft.quote_id || draft.task_id || !version?.eligible) {
      // A selected, closed or expired request must never be revived by approval.
      const status = !claim.rows[0] || !draft || draft.status === 'abandoned'
        ? 'withdrawn' : draft.quote_id || draft.task_id ? 'superseded' : 'expired';
      await query(`UPDATE quotes SET status = $3, updated_at = NOW() WHERE id = $1 AND status = $2`,
        [quote.id, PENDING_BUSINESS_VERIFICATION, status]);
      continue;
    }
    const decision = await query<{id: string}>('SELECT id FROM business_quote_eligibility_decisions WHERE quote_id=$1',[quote.id]);
    if (!decision.rows[0]) {
      // Legacy pending quotes get a first decision before publication. Existing
      // snapshots are historical and are not rechecked for ordinary later expiry.
      const eligibility = await evaluateBusinessTaskEligibility(query,{organizationId,taskDraftId:quote.task_draft_id,action:'SUBMIT_QUOTE'});
      if (!eligibility.eligible) continue;
      await query('UPDATE quotes SET provider_service_profile_id=$2 WHERE id=$1',[quote.id,eligibility.serviceProfileId]);
      await persistBusinessQuoteEligibilityDecision(query,eligibility,{organizationId,taskDraftId:quote.task_draft_id,quoteId:quote.id,quoteVersionId:version.id});
    }
    if (await publishBusinessQuoteInTransaction(query, {
      quoteId: quote.id, taskDraftId: quote.task_draft_id,
      posterUserId: draft.poster_user_id, fromStatus: PENDING_BUSINESS_VERIFICATION,
    })) activated += 1;
  }
  return activated;
}
