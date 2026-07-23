import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import { PRE_ADVERSE_REVIEW_HOURS } from './WorkerScreeningRightsPolicy.js';
import {
  screeningBadRequest as badRequest,
  screeningDigest as digest,
  type ScreeningCheckRow as CheckRow,
} from './WorkerScreeningRightsData.js';

export async function beginPreAdverseAction(params: {
  adminId: string; checkId: string; reasonCodes: string[]; providerName: string;
  providerAddress: string; providerPhone: string; reportAccessPath: string;
  disputeInstructions: string; rightsSummaryVersion: string; idempotencyKey: string;
}): Promise<{ status: 'PRE_ADVERSE'; finalActionEligibleAt: string }> {
  if (params.reasonCodes.length === 0 || !params.reportAccessPath.trim()) {
    badRequest('Report access and reason codes are required.');
  }
  const requestHash = digest(params);
  const finalActionEligibleAt = new Date(Date.now() + PRE_ADVERSE_REVIEW_HOURS * 60 * 60 * 1000).toISOString();
  return db.transaction(async (query) => {
    const checkResult = await query<CheckRow>(
      `SELECT id, user_id, provider, status, result_summary, initiated_at, completed_at, expires_at
       FROM background_checks WHERE id = $1 FOR UPDATE`, [params.checkId]);
    const check = checkResult.rows[0];
    if (!check) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening record not found.' });
    if (check.status !== 'CONSIDER' && check.status !== 'PRE_ADVERSE') {
      badRequest('Only a reviewable report can enter pre-adverse review.');
    }
    const insertedNotice = await query<{ final_action_eligible_at: string }>(
      `INSERT INTO worker_screening_notices (
         background_check_id, worker_id, notice_type, reason_codes, provider_name,
         provider_address, provider_phone, provider_decision_disclaimer, report_access_path,
         rights_summary_version, dispute_instructions, delivered_at, final_action_eligible_at, created_by
       ) VALUES ($1,$2,'PRE_ADVERSE',$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12)
       ON CONFLICT (background_check_id, notice_type) DO NOTHING
       RETURNING final_action_eligible_at`,
      [params.checkId, check.user_id, params.reasonCodes, params.providerName, params.providerAddress,
        params.providerPhone, 'The screening provider did not make HustleXP’s decision and cannot explain it.',
        params.reportAccessPath, params.rightsSummaryVersion, params.disputeInstructions,
        finalActionEligibleAt, params.adminId],
    );
    const notice = insertedNotice.rows[0] ?? (await query<{ final_action_eligible_at: string }>(
      `SELECT final_action_eligible_at FROM worker_screening_notices
       WHERE background_check_id = $1 AND notice_type = 'PRE_ADVERSE'`, [params.checkId],
    )).rows[0];
    await query(`UPDATE background_checks SET status = 'PRE_ADVERSE' WHERE id = $1`, [params.checkId]);
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'PRE_ADVERSE_SENT',$3,$4,$5,$6)
       ON CONFLICT (worker_id, idempotency_key) DO NOTHING`,
      [check.user_id, params.checkId, params.adminId, requestHash, `pre-adverse:${params.idempotencyKey}`,
        'A pre-adverse notice, report copy, and rights summary were made available before any final decision.'],
    );
    return { status: 'PRE_ADVERSE' as const, finalActionEligibleAt: notice.final_action_eligible_at };
  });
}

export async function resolveScreeningDispute(params: {
  adminId: string; disputeId: string; decision: 'CORRECTED_CLEAR' | 'UPHELD';
  resolutionNote: string; idempotencyKey: string;
}): Promise<{ status: 'CLEAR' | 'PRE_ADVERSE' }> {
  if (params.resolutionNote.trim().length < 10) badRequest('A meaningful resolution note is required.');
  const requestHash = digest(params);
  const result = await db.transaction(async (query) => {
    const dispute = await query<{ id: string; worker_id: string; background_check_id: string; status: string }>(
      `SELECT id, worker_id, background_check_id, status FROM worker_screening_disputes
       WHERE id = $1 FOR UPDATE`, [params.disputeId]);
    const row = dispute.rows[0];
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screening dispute not found.' });
    if (row.status !== 'OPEN') badRequest('This screening dispute is already resolved.');
    const status: 'CLEAR' | 'PRE_ADVERSE' = params.decision === 'CORRECTED_CLEAR' ? 'CLEAR' : 'PRE_ADVERSE';
    await query(
      `UPDATE worker_screening_disputes SET status = $2, resolution_note = $3,
         resolved_at = NOW(), resolved_by = $4 WHERE id = $1`,
      [params.disputeId, params.decision === 'CORRECTED_CLEAR' ? 'CORRECTED' : 'UPHELD',
        params.resolutionNote.trim(), params.adminId]);
    await query(`UPDATE background_checks SET status = $2, reviewed_at = NOW(), reviewed_by = $3 WHERE id = $1`,
      [row.background_check_id, status, params.adminId]);
    await query(
      `INSERT INTO worker_screening_events (
         worker_id, background_check_id, event_type, actor_id, request_hash, idempotency_key, public_message
       ) VALUES ($1,$2,'DISPUTE_RESOLVED',$3,$4,$5,$6)`,
      [row.worker_id, row.background_check_id, params.adminId, requestHash,
        `dispute-resolve:${params.idempotencyKey}`,
        status === 'CLEAR' ? 'Your dispute was corrected and the screening is clear.' : 'The dispute review upheld the report; appeal rights remain available after any final decision.'],
    );
    return { workerId: row.worker_id, checkId: row.background_check_id, status };
  });
  if (result.status === 'CLEAR') {
    await recomputeCapabilityProfile(result.workerId, {
      reason: 'background_check_dispute_corrected',
      sourceVerificationId: result.checkId,
    });
  }
  return { status: result.status };
}
