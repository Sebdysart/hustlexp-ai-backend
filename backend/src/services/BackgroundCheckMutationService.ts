import { createHash, randomUUID } from 'node:crypto';
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

async function recordInitiationEvent(
  initiation: BackgroundCheckInitiation,
  row: BackgroundCheckRow,
  externalCheckId: string,
): Promise<void> {
  const requestHash = createHash('sha256').update(JSON.stringify({
    userId: initiation.userId,
    provider: initiation.provider,
    consentId: initiation.consentId,
    externalCheckId,
  })).digest('hex');
  await db.query(
    `INSERT INTO worker_screening_events (
       worker_id, background_check_id, consent_id, event_type, actor_id,
       request_hash, idempotency_key, public_message
     ) VALUES ($1,$2,$3,'CHECK_INITIATED',$1,$4,$5,$6)`,
    [
      initiation.userId,
      row.id,
      initiation.consentId,
      requestHash,
      `check-initiated:${externalCheckId}`,
      'The named screening provider received the consent-bound screening request.',
    ],
  );
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
  const externalCheckId = `bc_${randomUUID()}`;
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const result = await db.query<BackgroundCheckRow>(
    `INSERT INTO background_checks (
      user_id, provider, check_id, status,
      initiated_at, expires_at, details, screening_consent_id
    )
    VALUES ($1, $2, $3, 'PENDING', NOW(), $4, $5, $6)
    RETURNING *`,
    [
      initiation.userId,
      initiation.provider,
      externalCheckId,
      expiresAt.toISOString(),
      JSON.stringify({
        providerPayloadPrepared: Boolean(
          initiation.ssnLast4 || initiation.dateOfBirth || initiation.fullName,
        ),
        sensitiveIdentityDataStored: false,
      }),
      initiation.consentId,
    ],
  );
  const row = result.rows[0];
  await recordInitiationEvent(initiation, row, externalCheckId);
  log.info(
    { userId: initiation.userId, provider: initiation.provider, checkId: row.id, externalCheckId },
    'Background check initiated',
  );
  return backgroundCheckFromRow(row);
}

export async function updateBackgroundCheckStatus(
  externalCheckId: string,
  status: 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER',
  resultSummary?: string,
  details?: Record<string, unknown>,
): Promise<BackgroundCheck> {
  const result = await db.query<BackgroundCheckRow>(
    `UPDATE background_checks
     SET status = $2,
         completed_at = CASE WHEN $2 IN ('CLEAR', 'CONSIDER') THEN NOW() ELSE NULL END,
         result_summary = COALESCE($3, result_summary),
         details = COALESCE($4, details)
     WHERE check_id = $1
     RETURNING *`,
    [externalCheckId, status, resultSummary || null, details ? JSON.stringify(details) : null],
  );
  if (result.rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Background check not found' });
  }
  const row = result.rows[0];
  if (status === 'CLEAR') {
    await recomputeCapabilityProfile(row.user_id, {
      reason: 'background_check_cleared',
      sourceVerificationId: row.id,
    });
  }
  log.info({ checkId: row.id, userId: row.user_id, status }, 'Background check status updated');
  return backgroundCheckFromRow(row);
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
  const result = await db.query<BackgroundCheckRow>(
    `UPDATE background_checks
     SET status = $3,
         reviewed_at = NOW(),
         reviewed_by = $2,
         notes = COALESCE($4, notes)
     WHERE id = $1
       AND status = 'CONSIDER'
     RETURNING *`,
    [checkId, adminUserId, decision, notes || null],
  );
  if (result.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Background check not found or not in CONSIDER status',
    });
  }
  const row = result.rows[0];
  await recomputeCapabilityProfile(row.user_id, {
    reason: 'background_check_reviewed_clear',
    sourceVerificationId: row.id,
  });
  log.info(
    { checkId, userId: row.user_id, adminUserId, decision },
    'Background check reviewed',
  );
  return backgroundCheckFromRow(row);
}
