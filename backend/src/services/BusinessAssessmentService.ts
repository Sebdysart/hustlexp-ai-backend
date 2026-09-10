import crypto from 'node:crypto';
import { db } from '../db.js';
import { assertVerifiedProvider } from './BusinessWorkspacePolicy.js';
import { NotificationService } from './NotificationService.js';

type AssessmentRequestResult =
  | { success: true; data: { assessmentRequestId: string; claimLinkId: string; taskDraftId: string; status: 'PENDING_ADMIN' } }
  | { success: false; error: { code: string; message: string } };

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

function failure(code: string, message: string): AssessmentRequestResult {
  return { success: false, error: { code, message } };
}

export async function requestBusinessAssessment(input: {
  token: string;
  organizationId: string;
  actorId: string;
  businessMessage: string;
  proposedWindowStart: string;
  proposedWindowEnd: string;
}): Promise<AssessmentRequestResult> {
  const businessMessage = input.businessMessage.trim();
  if (!businessMessage) return failure('ASSESSMENT_MESSAGE_REQUIRED', 'Please explain why an in-person assessment is required.');

  const windowStart = new Date(input.proposedWindowStart);
  const windowEnd = new Date(input.proposedWindowEnd);
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowEnd <= windowStart) {
    return failure('INVALID_ASSESSMENT_WINDOW', 'The proposed assessment window is invalid.');
  }

  try {
    return await db.transaction(async (query) => {
      const linkResult = await query<{ id: string; task_draft_id: string; status: string; expires_at: Date; invited_organization_id: string | null }>(
        `SELECT id, task_draft_id, status, expires_at, invited_organization_id
         FROM ops_business_claim_links WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(input.token)],
      );
      const link = linkResult.rows[0];
      if (!link || link.status !== 'OPEN') return failure('CLAIM_LINK_UNAVAILABLE', 'This claim link is invalid or no longer available.');
      if (link.expires_at <= new Date()) {
        await query(`UPDATE ops_business_claim_links SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1 AND status = 'OPEN'`, [link.id]);
        return failure('CLAIM_LINK_EXPIRED', 'This claim link has expired.');
      }
      if (link.invited_organization_id && link.invited_organization_id !== input.organizationId) {
        return failure('CLAIM_LINK_WRONG_BUSINESS', 'This claim link was created for another business.');
      }

      const draftResult = await query<{ id: string; status: string; task_id: string | null }>(
        `SELECT id, status, task_id FROM task_drafts WHERE id = $1 FOR UPDATE`,
        [link.task_draft_id],
      );
      const draft = draftResult.rows[0];
      if (!draft) return failure('TASK_DRAFT_NOT_FOUND', 'Task draft no longer exists.');
      if (draft.status === 'abandoned' || draft.task_id) return failure('TASK_DRAFT_UNAVAILABLE', 'This task is no longer available.');

      await query(`SELECT business_require_action($1, $2, 'ASSIGN_CREW')`, [input.organizationId, input.actorId]);
      const orgResult = await query<{ status: string; provider_enabled: boolean; verification_status: string; display_name: string | null }>(
        `SELECT status, provider_enabled, verification_status, display_name FROM business_organizations WHERE id = $1 FOR SHARE`,
        [input.organizationId],
      );
      const org = orgResult.rows[0];
      if (!org) return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to claim work.');
      try {
        assertVerifiedProvider({ status: org.status, verificationStatus: org.verification_status, providerEnabled: org.provider_enabled });
      } catch {
        return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to claim work.');
      }

      const existing = await query<{ id: string }>(
        `SELECT id FROM business_assessment_requests
         WHERE task_draft_id = $1 AND business_organization_id = $2
           AND status IN ('PENDING_ADMIN', 'AWAITING_CUSTOMER', 'SCHEDULED') LIMIT 1`,
        [draft.id, input.organizationId],
      );
      if (existing.rows[0]) return failure('ASSESSMENT_ALREADY_ACTIVE', 'This business already has an active assessment request for this task.');

      const assessmentResult = await query<{ id: string }>(
        `INSERT INTO business_assessment_requests
          (task_draft_id, business_organization_id, claim_link_id, requested_by_user_id,
           business_message, proposed_window_start, proposed_window_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [draft.id, input.organizationId, link.id, input.actorId, businessMessage, windowStart, windowEnd],
      );
      const assessmentRequestId = assessmentResult.rows[0]?.id;
      if (!assessmentRequestId) return failure('ASSESSMENT_CREATE_FAILED', 'Unable to create the assessment request.');

      await NotificationService.createForOperationsInTransaction(query, {
        type: 'ASSESSMENT_REQUESTED',
        title: 'New assessment request',
        message: `${org.display_name || 'A business'} requested an onsite assessment.`,
        entityType: 'assessment',
        entityId: assessmentRequestId,
        actionUrl: `/ops/drafts/${draft.id}`,
        dedupeKey: `assessment-requested:${assessmentRequestId}`,
      });

      const claimed = await query<{ id: string }>(
        `UPDATE ops_business_claim_links SET status = 'CLAIMED', claimed_by_organization_id = $2,
           claimed_by_business_user_id = $3, claimed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'OPEN' AND expires_at > NOW() RETURNING id`,
        [link.id, input.organizationId, input.actorId],
      );
      if (!claimed.rows[0]) throw new Error('CLAIM_RACE_LOST');

      await query(
        `INSERT INTO business_audit_events (organization_id, actor_id, action, object_type, object_id, after_state)
         VALUES ($1, $2, 'ASSESSMENT_REQUESTED', 'TASK_DRAFT', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, draft.id, JSON.stringify({ assessmentRequestId, proposedWindowStart: windowStart.toISOString(), proposedWindowEnd: windowEnd.toISOString() })],
      );
      return { success: true, data: { assessmentRequestId, claimLinkId: link.id, taskDraftId: draft.id, status: 'PENDING_ADMIN' } };
    });
  } catch {
    return failure('ASSESSMENT_REQUEST_FAILED', 'Unable to submit the assessment request.');
  }
}
