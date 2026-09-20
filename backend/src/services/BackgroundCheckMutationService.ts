import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import {
  backgroundCheckFromRow,
  type BackgroundCheck,
  type BackgroundCheckInitiation,
  type BackgroundCheckRow,
} from './BackgroundCheckTypes.js';
import {
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  WORKER_SCREENING_DISCLOSURE_VERSION,
} from './WorkerScreeningRightsPolicy.js';

const log = logger.child({ service: 'BackgroundCheckService' });

async function assertCurrentConsent(initiation: BackgroundCheckInitiation): Promise<void> {
  const result = await db.query<{ id: string; provider: string; disclosure_version: string }>(
    `SELECT id, provider, disclosure_version
     FROM worker_screening_consents
     WHERE id = $1 AND worker_id = $2 AND consent_granted = TRUE AND revoked_at IS NULL`,
    [initiation.consentId, initiation.userId],
  );
  const consent = result.rows[0];
  if (consent
      && consent.provider === initiation.provider
      && consent.disclosure_version === WORKER_SCREENING_DISCLOSURE_VERSION) return;
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'Current written screening consent is required before a check can start.',
  });
}

async function assertNoActiveCheck(userId: string): Promise<void> {
  const result = await db.query<{ id: string; status: string }>(
    `SELECT id, status
     FROM background_checks
     WHERE user_id = $1
       AND status IN ('PENDING', 'IN_PROGRESS', 'CLEAR')
       AND (expires_at IS NULL OR expires_at > CURRENT_DATE + INTERVAL '30 days')
     ORDER BY initiated_at DESC
     LIMIT 1`,
    [userId],
  );
  const existing = result.rows[0];
  if (!existing) return;
  const message = existing.status === 'CLEAR'
    ? 'Valid background check already on file'
    : 'Background check already in progress';
  throw new TRPCError({ code: 'CONFLICT', message });
}

export async function initiateBackgroundCheck(
  initiation: BackgroundCheckInitiation,
): Promise<BackgroundCheck> {
  if (initiation.provider === LOCAL_CERTIFICATION_SCREENING_PROVIDER) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Local certification TEST screening must use its isolated provider workflow.',
    });
  }
  await assertCurrentConsent(initiation);
  await assertNoActiveCheck(initiation.userId);
  // No external screening adapter sends this request. A locally generated ID
  // cannot be presented as evidence that Checkr/Sterling/GoodHire received it.
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This screening provider is not connected. No background check was ordered.',
  });
}

export async function updateBackgroundCheckStatus(
  externalCheckId: string,
  status: 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'DISPUTED',
  providerEvent: { id: string; occurredAt: string },
  resultSummary?: string,
  details?: Record<string, unknown>,
): Promise<BackgroundCheck> {
  const occurredAt = new Date(providerEvent.occurredAt);
  if (!providerEvent.id || !Number.isFinite(occurredAt.getTime())) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Valid provider event identity and time are required.' });
  }
  const outcome = await db.transaction(async (query) => {
    const result = await query<BackgroundCheckRow>(
      `UPDATE background_checks check_row
       SET status = $2,
           completed_at = CASE WHEN $2 IN ('CLEAR', 'CONSIDER')
             THEN COALESCE(check_row.completed_at, NOW()) ELSE check_row.completed_at END,
           result_summary = COALESCE($3, check_row.result_summary),
           details = COALESCE($4::jsonb, check_row.details),
           last_provider_event_id = $5,
           last_provider_event_at = $6::timestamptz
       WHERE check_row.check_id = $1
         AND check_row.provider = 'checkr'
         AND check_row.provider_environment = 'PRODUCTION'
         AND check_row.is_test IS FALSE
         AND check_row.reviewed_at IS NULL
         AND (check_row.last_provider_event_at IS NULL
              OR check_row.last_provider_event_at < $6::timestamptz)
         AND (
           ($2 = 'CLEAR' AND check_row.status IN ('PENDING', 'IN_PROGRESS'))
           OR ($2 = 'CONSIDER' AND check_row.status IN ('PENDING', 'IN_PROGRESS', 'CLEAR'))
           OR ($2 = 'DISPUTED' AND check_row.status IN ('PENDING', 'IN_PROGRESS', 'CLEAR', 'CONSIDER'))
           OR ($2 = 'IN_PROGRESS' AND check_row.status = 'PENDING')
         )
         AND NOT EXISTS (
           SELECT 1 FROM worker_screening_disputes dispute
           WHERE dispute.background_check_id = check_row.id AND dispute.status = 'OPEN'
         )
       RETURNING *`,
      [externalCheckId, status, resultSummary || null,
        details ? JSON.stringify(details) : null, providerEvent.id, occurredAt],
    );
    const updated = result.rows[0];
    if (updated) {
      await recomputeCapabilityProfile(updated.user_id, {
        reason: `background_check_provider_${status.toLowerCase()}`,
        sourceVerificationId: updated.id,
      }, query);
      return { row: updated, applied: true };
    }
    const existing = await query<BackgroundCheckRow>(
      `SELECT * FROM background_checks
       WHERE check_id = $1 AND provider = 'checkr'
         AND provider_environment = 'PRODUCTION' AND is_test IS FALSE`,
      [externalCheckId],
    );
    if (!existing.rows[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Background check not found' });
    }
    return { row: existing.rows[0], applied: false };
  });
  log.info(
    { checkId: outcome.row.id, userId: outcome.row.user_id, status, applied: outcome.applied },
    'Background check provider event processed',
  );
  return backgroundCheckFromRow(outcome.row);
}

export async function reviewBackgroundCheck(
  checkId: string,
  adminUserId: string,
  decision: 'CLEAR' | 'FAILED',
  notes?: string,
): Promise<BackgroundCheck> {
  if (decision === 'FAILED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A final adverse decision requires report access, pre-adverse notice, review time, and dispute handling.',
    });
  }
  const row = await db.transaction(async (query) => {
    const result = await query<BackgroundCheckRow>(
      `UPDATE background_checks
       SET status = $3,
           reviewed_at = NOW(),
           reviewed_by = $2,
           notes = COALESCE($4, notes)
       WHERE id = $1
         AND status = 'CONSIDER'
         AND NOT EXISTS (
           SELECT 1 FROM worker_screening_disputes dispute
           WHERE dispute.background_check_id = background_checks.id AND dispute.status = 'OPEN'
         )
       RETURNING *`,
      [checkId, adminUserId, decision, notes || null],
    );
    const updated = result.rows[0];
    if (!updated) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Background check not found or not in CONSIDER status; an open dispute also blocks review',
      });
    }
    await recomputeCapabilityProfile(updated.user_id, {
      reason: 'background_check_reviewed_clear',
      sourceVerificationId: updated.id,
    }, query);
    return updated;
  });
  log.info(
    { checkId, userId: row.user_id, adminUserId, decision },
    'Background check reviewed',
  );
  return backgroundCheckFromRow(row);
}
