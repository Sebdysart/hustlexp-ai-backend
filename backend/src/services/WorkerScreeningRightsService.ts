import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import {
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
  WORKER_SCREENING_DISCLOSURE_VERSION,
  WORKER_SCREENING_POLICY_VERSION,
  projectScreeningRights,
  validateScreeningConsent,
  type ScreeningConsentInput,
  type ScreeningProvider,
} from './WorkerScreeningRightsPolicy.js';
import { localCertificationScreeningEnabled } from './LocalCertificationScreeningProvider.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import {
  screeningBadRequest as badRequest,
  screeningDigest as digest,
  type ScreeningCheckRow as CheckRow,
  type ScreeningQuery as Query,
} from './WorkerScreeningRightsData.js';

export async function grantScreeningConsent(params: ScreeningConsentInput & {
  workerId: string;
  provider: ScreeningProvider;
  purpose: string;
  disclosureHash: string;
  idempotencyKey: string;
}): Promise<{ consentId: string; disclosureVersion: string; grantedAt: string }> {
  const blockers = validateScreeningConsent(params);
  if (blockers.length > 0) badRequest(`Screening consent is incomplete: ${blockers.join(', ')}`);
  const isLocalTest = params.provider === LOCAL_CERTIFICATION_SCREENING_PROVIDER;
  if (isLocalTest && !localCertificationScreeningEnabled()) {
    badRequest('Local certification TEST screening is disabled.');
  }
  if (isLocalTest && params.purpose.trim() !== LOCAL_CERTIFICATION_SCREENING_PURPOSE) {
    badRequest('Local certification TEST screening purpose does not match the standalone disclosure.');
  }
  const requestHash = digest({
    workerId: params.workerId,
    provider: params.provider,
    purpose: params.purpose.trim(),
    disclosureVersion: params.disclosureVersion,
    disclosureHash: params.disclosureHash,
    policyVersion: WORKER_SCREENING_POLICY_VERSION,
  });

  return db.transaction(async (query) => {
    if (isLocalTest) {
      await query(`SELECT set_config('hustlexp.local_test_screening_enabled', 'true', true)`);
    }
    const replay = await query<{ id: string; request_hash: string; disclosure_version: string; granted_at: string }>(
      `SELECT id, request_hash, disclosure_version, granted_at
       FROM worker_screening_consents
       WHERE worker_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [params.workerId, params.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Consent key was already used for different terms.' });
      }
      return {
        consentId: replay.rows[0].id,
        disclosureVersion: replay.rows[0].disclosure_version,
        grantedAt: replay.rows[0].granted_at,
      };
    }

    const inserted = await query<{ id: string; disclosure_version: string; granted_at: string }>(
      `INSERT INTO worker_screening_consents (
         worker_id, provider, disclosure_version, disclosure_hash, policy_version, purpose,
         consent_granted, disclosure_presented_standalone, purpose_acknowledged,
         rights_summary_acknowledged, request_hash, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,TRUE,TRUE,$7,$8)
       RETURNING id, disclosure_version, granted_at`,
      [params.workerId, params.provider, params.disclosureVersion, params.disclosureHash,
        WORKER_SCREENING_POLICY_VERSION, params.purpose.trim(), requestHash, params.idempotencyKey],
    );
    const consent = inserted.rows[0];
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, consent_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'CONSENT_GRANTED',$1,$3,$4,$5)`,
      [params.workerId, consent.id, requestHash, `consent:${params.idempotencyKey}`,
        isLocalTest
          ? 'You gave written permission to run a controlled TEST eligibility fixture. No external background report will be ordered.'
          : 'You gave written permission for the named provider to run this screening.'],
    );
    return { consentId: consent.id, disclosureVersion: consent.disclosure_version, grantedAt: consent.granted_at };
  });
}

export async function revokeFutureScreeningConsent(params: {
  workerId: string;
  consentId: string;
  idempotencyKey: string;
}): Promise<{ revoked: true }> {
  const requestHash = digest(params);
  return db.transaction(async (query) => {
    const consent = await query<{ id: string; revoked_at: string | null }>(
      `SELECT id, revoked_at FROM worker_screening_consents
       WHERE id = $1 AND worker_id = $2 FOR UPDATE`,
      [params.consentId, params.workerId],
    );
    if (!consent.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening consent not found.' });
    if (!consent.rows[0].revoked_at) {
      await query(`UPDATE worker_screening_consents SET revoked_at = NOW() WHERE id = $1`, [params.consentId]);
    }
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, consent_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'CONSENT_REVOKED',$1,$3,$4,$5)
       ON CONFLICT (worker_id, idempotency_key) DO NOTHING`,
      [params.workerId, params.consentId, requestHash, `revoke:${params.idempotencyKey}`,
        'Permission for future screening orders was withdrawn. Existing report rights remain available.'],
    );
    return { revoked: true };
  });
}

interface ScreeningConsentRow {
  id: string;
  provider: string;
  disclosure_version: string;
  granted_at: string;
  revoked_at: string | null;
}

interface ScreeningNoticeRow {
  delivered_at: string;
  final_action_eligible_at: string | null;
  report_access_path: string;
  provider_name: string;
  provider_address: string;
  provider_phone: string;
  dispute_instructions: string;
}

interface ScreeningCaseRow {
  id: string;
  status: string;
  reason: string;
  opened_at: string;
}

function activeConsentView(consent: ScreeningConsentRow | null) {
  if (!consent) return null;
  return {
    id: consent.id,
    provider: consent.provider,
    disclosureVersion: consent.disclosure_version,
    grantedAt: consent.granted_at,
    revokedAt: consent.revoked_at,
    activeForFutureOrders: consent.revoked_at === null,
  };
}

function screeningReportView(
  check: CheckRow,
  notice: ScreeningNoticeRow | undefined,
  reportAvailable: boolean,
) {
  if (!reportAvailable) return null;
  return {
    summary: check.result_summary,
    accessPath: notice?.report_access_path ?? null,
    provider: notice
      ? { name: notice.provider_name, address: notice.provider_address, phone: notice.provider_phone }
      : null,
    disputeInstructions: notice?.dispute_instructions ?? null,
  };
}

export async function getMyScreeningRights(workerId: string) {
  const [checkResult, consentResult] = await Promise.all([
    db.query<CheckRow>(
      `SELECT id, user_id, provider, status, result_summary, initiated_at, completed_at, expires_at
       FROM background_checks WHERE user_id = $1 ORDER BY initiated_at DESC LIMIT 1`,
      [workerId],
    ),
    db.query<ScreeningConsentRow>(
      `SELECT id, provider, disclosure_version, granted_at, revoked_at
       FROM worker_screening_consents WHERE worker_id = $1 ORDER BY granted_at DESC LIMIT 1`,
      [workerId],
    ),
  ]);
  const check = checkResult.rows[0];
  const consent = consentResult.rows[0] ?? null;
  const activeConsent = activeConsentView(consent);
  if (!check) {
    return {
      check: null,
      activeConsent,
      report: null,
      activeDispute: null,
      activeAppeal: null,
      rights: projectScreeningRights({
        status: 'NOT_STARTED', reportAvailable: false, preAdverseNoticeDelivered: false,
        reviewWindowElapsed: false, openDispute: false,
      }),
    };
  }

  const [noticeResult, disputeResult, appealResult] = await Promise.all([
    db.query<ScreeningNoticeRow>(
      `SELECT delivered_at, final_action_eligible_at, report_access_path, provider_name,
              provider_address, provider_phone, dispute_instructions
       FROM worker_screening_notices
       WHERE background_check_id = $1 AND notice_type = 'PRE_ADVERSE' LIMIT 1`, [check.id]),
    db.query<ScreeningCaseRow>(
      `SELECT id, status, reason, opened_at FROM worker_screening_disputes
       WHERE background_check_id = $1 ORDER BY opened_at DESC LIMIT 1`, [check.id]),
    db.query<ScreeningCaseRow>(
      `SELECT id, status, reason, opened_at FROM worker_screening_appeals
       WHERE background_check_id = $1 ORDER BY opened_at DESC LIMIT 1`, [check.id]),
  ]);
  const notice = noticeResult.rows[0];
  const dispute = disputeResult.rows[0] ?? null;
  const appeal = appealResult.rows[0] ?? null;
  const reportAvailable = Boolean(check.result_summary || notice?.report_access_path);
  const reviewWindowElapsed = Boolean(notice?.final_action_eligible_at && new Date(notice.final_action_eligible_at) <= new Date());

  return {
    activeConsent,
    check: {
      id: check.id, provider: check.provider, status: check.status, initiatedAt: check.initiated_at,
      completedAt: check.completed_at, expiresAt: check.expires_at,
    },
    report: screeningReportView(check, notice, reportAvailable),
    activeDispute: dispute,
    activeAppeal: appeal,
    rights: projectScreeningRights({
      status: check.status,
      reportAvailable,
      preAdverseNoticeDelivered: Boolean(notice?.delivered_at),
      reviewWindowElapsed,
      openDispute: dispute?.status === 'OPEN',
    }),
  };
}

async function loadOwnedCheck(query: Query, workerId: string, checkId: string): Promise<CheckRow> {
  const result = await query<CheckRow>(
    `SELECT id, user_id, provider, status, result_summary, initiated_at, completed_at, expires_at
     FROM background_checks WHERE id = $1 AND user_id = $2 FOR UPDATE`, [checkId, workerId]);
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening record not found.' });
  return result.rows[0];
}

export async function submitScreeningDispute(params: {
  workerId: string; checkId: string; reason: string; idempotencyKey: string;
}): Promise<{ disputeId: string; status: 'OPEN' }> {
  if (params.reason.trim().length < 10) badRequest('Explain what is inaccurate or incomplete.');
  const requestHash = digest(params);
  return db.transaction(async (query) => {
    const check = await loadOwnedCheck(query, params.workerId, params.checkId);
    if (!['CONSIDER', 'PRE_ADVERSE', 'DISPUTED', 'FAILED'].includes(check.status)) {
      badRequest('This screening state is not open for dispute.');
    }
    const replay = await query<{ id: string; request_hash: string }>(
      `SELECT d.id, e.request_hash FROM worker_screening_disputes d
       JOIN worker_screening_events e ON e.background_check_id = d.background_check_id
        AND e.idempotency_key = $3
       WHERE d.background_check_id = $1 AND d.worker_id = $2 ORDER BY d.opened_at DESC LIMIT 1`,
      [params.checkId, params.workerId, `dispute:${params.idempotencyKey}`],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) throw new TRPCError({ code: 'CONFLICT', message: 'Dispute key was reused with different details.' });
      return { disputeId: replay.rows[0].id, status: 'OPEN' as const };
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO worker_screening_disputes (background_check_id, worker_id, reason)
       VALUES ($1,$2,$3) RETURNING id`, [params.checkId, params.workerId, params.reason.trim()]);
    await query(`UPDATE background_checks SET status = 'DISPUTED' WHERE id = $1`, [params.checkId]);
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'DISPUTE_OPENED',$1,$3,$4,$5)`,
      [params.workerId, params.checkId, requestHash, `dispute:${params.idempotencyKey}`,
        'Your report dispute is open. Final adverse action is paused during review.'],
    );
    return { disputeId: inserted.rows[0].id, status: 'OPEN' as const };
  });
}

export async function submitScreeningAppeal(params: {
  workerId: string; checkId: string; reason: string; idempotencyKey: string;
}): Promise<{ appealId: string; status: 'OPEN' }> {
  if (params.reason.trim().length < 10) badRequest('Explain why the final decision should be reviewed.');
  const requestHash = digest(params);
  return db.transaction(async (query) => {
    const check = await loadOwnedCheck(query, params.workerId, params.checkId);
    if (check.status !== 'FAILED') badRequest('An appeal is available after a final adverse decision.');
    const inserted = await query<{ id: string }>(
      `INSERT INTO worker_screening_appeals (background_check_id, worker_id, reason)
       VALUES ($1,$2,$3)
       ON CONFLICT (background_check_id) WHERE status = 'OPEN' DO UPDATE SET reason = worker_screening_appeals.reason
       RETURNING id`, [params.checkId, params.workerId, params.reason.trim()]);
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'APPEAL_OPENED',$1,$3,$4,$5)
       ON CONFLICT (worker_id, idempotency_key) DO NOTHING`,
      [params.workerId, params.checkId, requestHash, `appeal:${params.idempotencyKey}`,
        'Your appeal is open for a new human review.'],
    );
    return { appealId: inserted.rows[0].id, status: 'OPEN' as const };
  });
}

export async function finalizeAdverseAction(params: {
  adminId: string; checkId: string; idempotencyKey: string;
}): Promise<{ status: 'FAILED' }> {
  const requestHash = digest(params);
  return db.transaction(async (query) => {
    const checkResult = await query<CheckRow>(
      `SELECT id, user_id, provider, status, result_summary, initiated_at, completed_at, expires_at
       FROM background_checks WHERE id = $1 FOR UPDATE`, [params.checkId]);
    const check = checkResult.rows[0];
    if (!check) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening record not found.' });
    const pre = await query<{ reason_codes: string[]; provider_name: string; provider_address: string; provider_phone: string; provider_decision_disclaimer: string; report_access_path: string; rights_summary_version: string; dispute_instructions: string }>(
      `SELECT reason_codes, provider_name, provider_address, provider_phone, provider_decision_disclaimer,
              report_access_path, rights_summary_version, dispute_instructions
       FROM worker_screening_notices WHERE background_check_id = $1 AND notice_type = 'PRE_ADVERSE'`, [params.checkId]);
    if (!pre.rows[0]) badRequest('Pre-adverse notice is required before final action.');
    await query(`UPDATE background_checks SET status = 'FAILED', reviewed_at = NOW(), reviewed_by = $2 WHERE id = $1`,
      [params.checkId, params.adminId]);
    const n = pre.rows[0];
    await query(
      `INSERT INTO worker_screening_notices (
         background_check_id, worker_id, notice_type, reason_codes, provider_name, provider_address,
         provider_phone, provider_decision_disclaimer, report_access_path, rights_summary_version,
         dispute_instructions, free_report_deadline_at, delivered_at, created_by
       ) VALUES ($1,$2,'FINAL_ADVERSE',$3,$4,$5,$6,$7,$8,$9,$10,NOW() + INTERVAL '60 days',NOW(),$11)
       ON CONFLICT (background_check_id, notice_type) DO NOTHING`,
      [params.checkId, check.user_id, n.reason_codes, n.provider_name, n.provider_address,
        n.provider_phone, n.provider_decision_disclaimer, n.report_access_path,
        n.rights_summary_version, n.dispute_instructions, params.adminId],
    );
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'ADVERSE_SENT',$3,$4,$5,$6)`,
      [check.user_id, params.checkId, params.adminId, requestHash, `adverse:${params.idempotencyKey}`,
        'A final decision notice was delivered with provider, dispute, free-report, and appeal information.'],
    );
    return { status: 'FAILED' as const };
  });
}

export async function resolveScreeningAppeal(params: {
  adminId: string; appealId: string; decision: 'OVERTURNED' | 'UPHELD';
  resolutionNote: string; idempotencyKey: string;
}): Promise<{ status: 'CLEAR' | 'FAILED' }> {
  if (params.resolutionNote.trim().length < 10) badRequest('A meaningful appeal decision is required.');
  const requestHash = digest(params);
  const result = await db.transaction(async (query) => {
    const appeal = await query<{ worker_id: string; background_check_id: string; status: string }>(
      `SELECT worker_id, background_check_id, status FROM worker_screening_appeals WHERE id = $1 FOR UPDATE`,
      [params.appealId]);
    const row = appeal.rows[0];
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening appeal not found.' });
    if (row.status !== 'OPEN') badRequest('This appeal is already resolved.');
    const status: 'CLEAR' | 'FAILED' = params.decision === 'OVERTURNED' ? 'CLEAR' : 'FAILED';
    await query(
      `UPDATE worker_screening_appeals SET status = $2, resolution_note = $3,
         resolved_at = NOW(), resolved_by = $4 WHERE id = $1`,
      [params.appealId, params.decision, params.resolutionNote.trim(), params.adminId]);
    await query(`UPDATE background_checks SET status = $2, reviewed_at = NOW(), reviewed_by = $3 WHERE id = $1`,
      [row.background_check_id, status, params.adminId]);
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'APPEAL_RESOLVED',$3,$4,$5,$6)`,
      [row.worker_id, row.background_check_id, params.adminId, requestHash,
        `appeal-resolve:${params.idempotencyKey}`,
        status === 'CLEAR' ? 'A new human review overturned the decision and cleared the screening.' : 'A new human review upheld the decision.'],
    );
    return { workerId: row.worker_id, checkId: row.background_check_id, status };
  });
  if (result.status === 'CLEAR') {
    await recomputeCapabilityProfile(result.workerId, { reason: 'background_check_appeal_overturned', sourceVerificationId: result.checkId });
  }
  return { status: result.status };
}

export { beginPreAdverseAction, resolveScreeningDispute } from './WorkerScreeningAdverseService.js';
export { WORKER_SCREENING_DISCLOSURE_VERSION };
