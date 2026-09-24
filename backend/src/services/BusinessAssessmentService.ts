import crypto from 'node:crypto';
import { db } from '../db.js';
import { assertVerifiedProvider } from './BusinessWorkspacePolicy.js';
import { NotificationService } from './NotificationService.js';
import { logger } from '../logger.js';
import { assertProviderOsAccess } from './ProviderOsAccess.js';
import { isProviderOsEligibleDraft } from './ProviderOsPolicy.js';

const log = logger.child({ service: 'BusinessAssessmentService' });

function assessmentFailureDetails(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const safeIdentifier = (field: unknown) =>
    typeof field === 'string' && /^[a-zA-Z0-9_]{1,128}$/.test(field) ? field : undefined;
  const code = safeIdentifier(value.code);
  return {
    errorClass: error instanceof Error ? error.constructor.name : typeof error,
    dbCode: code,
    dbConstraint: safeIdentifier(value.constraint),
    dbTable: safeIdentifier(value.table),
    dbColumn: safeIdentifier(value.column),
    message: code === '23502' ? 'Required database value was null' : 'Assessment transaction failed',
  };
}

type AssessmentRequestResult =
  | { success: true; data: { assessmentRequestId: string; claimLinkId: string; taskDraftId: string; status: 'PENDING_ADMIN' } }
  | { success: false; error: { code: string; message: string } };

type ProposalAssessmentRequestResult =
  | {
      success: true;
      data: {
        assessmentRequestId: string;
        proposalId: string;
        taskDraftId: string;
        status: 'PENDING_ADMIN';
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

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

export async function requestBusinessProposalAssessment(input: {
  proposalId: string;
  actorId: string;
  businessMessage: string;
  proposedWindowStart: string;
  proposedWindowEnd: string;
}): Promise<ProposalAssessmentRequestResult> {
  let organizationId: string | undefined;
  const businessMessage = input.businessMessage.trim();

  if (!businessMessage) {
    return {
      success: false,
      error: {
        code: 'ASSESSMENT_MESSAGE_REQUIRED',
        message: 'Please explain why an in-person assessment is required.',
      },
    };
  }

  const windowStart = new Date(input.proposedWindowStart);
  const windowEnd = new Date(input.proposedWindowEnd);

  if (
    !Number.isFinite(windowStart.getTime()) ||
    !Number.isFinite(windowEnd.getTime()) ||
    windowEnd <= windowStart
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_ASSESSMENT_WINDOW',
        message: 'The proposed assessment window is invalid.',
      },
    };
  }

  try {
    return await db.transaction(async (query) => {
      const proposalResult = await query<{
        id: string;
        task_draft_id: string;
        business_organization_id: string;
        status: string;
        expires_at: Date;
      }>(
        `
        SELECT id, task_draft_id, business_organization_id, status, expires_at
        FROM business_task_proposals
        WHERE id = $1
        FOR UPDATE
        `,
        [input.proposalId],
      );
      const proposal = proposalResult.rows[0];
      organizationId = proposal?.business_organization_id;

      if (!proposal || !['PENDING', 'VIEWED'].includes(proposal.status)) {
        return {
          success: false,
          error: {
            code: 'PROPOSAL_UNAVAILABLE',
            message: 'This task proposal is no longer available.',
          },
        };
      }

      if (proposal.expires_at <= new Date()) {
        await query(
          `
          UPDATE business_task_proposals
          SET status = 'EXPIRED',
              responded_at = COALESCE(responded_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
            AND status IN ('PENDING', 'VIEWED')
          `,
          [proposal.id],
        );

        return {
          success: false,
          error: {
            code: 'PROPOSAL_EXPIRED',
            message: 'This task proposal has expired.',
          },
        };
      }

      const draftResult = await query<{
        id: string;
        status: string;
        task_id: string | null;
      }>(
        `
        SELECT id, status, task_id
        FROM task_drafts
        WHERE id = $1
        FOR UPDATE
        `,
        [proposal.task_draft_id],
      );
      const draft = draftResult.rows[0];

      if (!draft) {
        return {
          success: false,
          error: {
            code: 'TASK_DRAFT_NOT_FOUND',
            message: 'Task draft no longer exists.',
          },
        };
      }

      if (draft.status === 'abandoned' || draft.task_id) {
        return {
          success: false,
          error: {
            code: 'TASK_DRAFT_UNAVAILABLE',
            message: 'This task is no longer available.',
          },
        };
      }

      await query(
        `SELECT business_require_action($1, $2, 'ASSIGN_CREW')`,
        [proposal.business_organization_id, input.actorId],
      );

      const orgResult = await query<{
        status: string;
        provider_enabled: boolean;
        verification_status: string;
        display_name: string | null;
      }>(
        `
        SELECT status, provider_enabled, verification_status, display_name
        FROM business_organizations
        WHERE id = $1
        FOR SHARE
        `,
        [proposal.business_organization_id],
      );
      const org = orgResult.rows[0];

      if (!org) {
        return {
          success: false,
          error: {
            code: 'BUSINESS_NOT_READY',
            message: 'The business organization is not currently eligible to accept work.',
          },
        };
      }

      try {
        assertVerifiedProvider({
          status: org.status,
          verificationStatus: org.verification_status,
          providerEnabled: org.provider_enabled,
        });
      } catch {
        return {
          success: false,
          error: {
            code: 'BUSINESS_NOT_READY',
            message: 'The business organization is not currently eligible to accept work.',
          },
        };
      }

      const existing = await query<{ id: string }>(
        `
        SELECT id
        FROM business_assessment_requests
        WHERE task_draft_id = $1
          AND business_organization_id = $2
          AND status IN ('PENDING_ADMIN', 'AWAITING_CUSTOMER', 'SCHEDULED')
        LIMIT 1
        `,
        [draft.id, proposal.business_organization_id],
      );

      if (existing.rows[0]) {
        return {
          success: false,
          error: {
            code: 'ASSESSMENT_ALREADY_ACTIVE',
            message: 'This business already has an active assessment request for this task.',
          },
        };
      }

      const assessmentResult = await query<{ id: string }>(
        `
        INSERT INTO business_assessment_requests
          (
            task_draft_id,
            business_organization_id,
            proposal_id,
            requested_by_user_id,
            business_message,
            proposed_window_start,
            proposed_window_end
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `,
        [
          draft.id,
          proposal.business_organization_id,
          proposal.id,
          input.actorId,
          businessMessage,
          windowStart,
          windowEnd,
        ],
      );
      const assessmentRequestId = assessmentResult.rows[0]?.id;

      if (!assessmentRequestId) {
        return {
          success: false,
          error: {
            code: 'ASSESSMENT_CREATE_FAILED',
            message: 'Unable to create the assessment request.',
          },
        };
      }

      await NotificationService.createForOperationsInTransaction(query, {
        type: 'ASSESSMENT_REQUESTED',
        title: 'New assessment request',
        message: `${org.display_name || 'A business'} requested an onsite assessment.`,
        entityType: 'assessment',
        entityId: assessmentRequestId,
        actionUrl: `/ops/drafts/${draft.id}`,
        dedupeKey: `assessment-requested:${assessmentRequestId}`,
      });

      await query(
        `
        INSERT INTO business_audit_events
          (organization_id, actor_id, action, object_type, object_id, after_state)
        VALUES ($1, $2, 'ASSESSMENT_REQUESTED', 'TASK_DRAFT', $3, $4::jsonb)
        `,
        [
          proposal.business_organization_id,
          input.actorId,
          draft.id,
          JSON.stringify({
            assessmentRequestId,
            proposalId: proposal.id,
            source: 'BUSINESS_PROPOSAL',
            proposedWindowStart: windowStart.toISOString(),
            proposedWindowEnd: windowEnd.toISOString(),
          }),
        ],
      );

      return {
        success: true,
        data: {
          assessmentRequestId,
          proposalId: proposal.id,
          taskDraftId: draft.id,
          status: 'PENDING_ADMIN' as const,
        },
      };
    });
  } catch (error) {
    log.error({
      action: 'businessProposal.requestAssessment',
      proposalId: input.proposalId,
      organizationId,
      actorId: input.actorId,
      ...assessmentFailureDetails(error),
    }, 'Business proposal assessment transaction failed');
    return {
      success: false,
      error: {
        code: 'ASSESSMENT_REQUEST_FAILED',
        message: 'Unable to submit the assessment request.',
      },
    };
  }
}

/** Provider OS supplies a consented organization/client relationship, never a claim token. */
export async function requestProviderOsAssessment(input: {
  draftId: string;
  organizationId: string;
  actorId: string;
  businessMessage: string;
  proposedWindowStart: string;
  proposedWindowEnd: string;
}) {
  const message = input.businessMessage.trim();
  const windowStart = new Date(input.proposedWindowStart);
  const windowEnd = new Date(input.proposedWindowEnd);
  if (!message) return { success: false as const, error: { code: 'ASSESSMENT_MESSAGE_REQUIRED', message: 'Explain why an onsite assessment is needed.' } };
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowEnd <= windowStart) {
    return { success: false as const, error: { code: 'INVALID_ASSESSMENT_WINDOW', message: 'The proposed assessment window is invalid.' } };
  }
  try {
    return await db.transaction(async (query) => {
      await assertProviderOsAccess({ actorId: input.actorId, organizationId: input.organizationId, operation: 'ASSIGN_CREW' }, query);
      const org = (await query<{ status: string; provider_enabled: boolean; verification_status: string; display_name: string | null }>(
        'SELECT status, provider_enabled, verification_status, display_name FROM business_organizations WHERE id=$1 FOR SHARE',
        [input.organizationId],
      )).rows[0];
      try {
        if (!org) throw new Error('Business missing');
        assertVerifiedProvider({ status: org.status, providerEnabled: org.provider_enabled, verificationStatus: org.verification_status });
      } catch {
        return { success: false as const, error: { code: 'BUSINESS_NOT_READY', message: 'The business is not verified to request an assessment.' } };
      }
      const draft = (await query<{ id: string; poster_user_id: string | null; status: string; claimed_at: Date | null; task_id: string | null; quote_id: string | null }>(
        `SELECT id, poster_user_id, status, claimed_at, task_id, quote_id FROM task_drafts WHERE id=$1 FOR UPDATE`,
        [input.draftId],
      )).rows[0];
      if (!draft || !isProviderOsEligibleDraft({ status: draft.status, claimedAt: draft.claimed_at,
        taskId: draft.task_id, posterUserId: draft.poster_user_id, quoteId: draft.quote_id })) {
        return { success: false as const, error: { code: 'TASK_DRAFT_UNAVAILABLE', message: 'This client request is no longer eligible for an assessment.' } };
      }
      const relationship = (await query<{ id: string }>(
        `SELECT r.id FROM provider_os_relationships r
         JOIN users client ON client.id=r.poster_user_id AND client.account_status='ACTIVE'
         WHERE r.provider_organization_id=$1 AND r.poster_user_id=$2 AND r.status='active'
         FOR SHARE OF r, client`, [input.organizationId, draft.poster_user_id],
      )).rows[0];
      if (!relationship) return { success: false as const, error: { code: 'FORBIDDEN', message: 'This customer is not an active Provider OS client of this business.' } };
      const quoted = await query<{ id: string }>(
        `SELECT id FROM quotes WHERE task_draft_id=$1 AND business_organization_id=$2
         AND status NOT IN ('rejected','withdrawn','expired','superseded') LIMIT 1`,
        [draft.id, input.organizationId],
      );
      if (quoted.rows[0]) return { success: false as const, error: { code: 'ALREADY_QUOTED', message: 'This business has already quoted this request.' } };
      const activeAssessment = await query<{ id: string }>(
        `SELECT id FROM business_assessment_requests
         WHERE task_draft_id=$1 AND business_organization_id=$2
           AND status IN ('PENDING_ADMIN','AWAITING_CUSTOMER','SCHEDULED','COMPLETED') LIMIT 1`,
        [draft.id, input.organizationId],
      );
      if (activeAssessment.rows[0]) return { success: false as const, error: { code: 'ASSESSMENT_ALREADY_ACTIVE', message: 'This business already has an active assessment for this request.' } };
      const existing = await query<{ id: string }>(
        `SELECT id FROM business_assessment_requests WHERE task_draft_id=$1 AND business_organization_id=$2
         AND provider_os_relationship_id=$3 LIMIT 1`,
        [draft.id, input.organizationId, relationship.id],
      );
      if (existing.rows[0]) return { success: false as const, error: { code: 'ASSESSMENT_ALREADY_EXISTS', message: 'This business already has an assessment for this request.' } };
      const created = await query<{ id: string }>(
        `INSERT INTO business_assessment_requests
         (task_draft_id,business_organization_id,provider_os_relationship_id,requested_by_user_id,
          business_message,proposed_window_start,proposed_window_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [draft.id,input.organizationId,relationship.id,input.actorId,message,windowStart,windowEnd],
      );
      const assessmentRequestId = created.rows[0].id;
      await NotificationService.createForOperationsInTransaction(query, {
        type: 'ASSESSMENT_REQUESTED', title: 'New assessment request',
        message: `${org.display_name || 'A business'} requested an onsite assessment.`,
        entityType: 'assessment', entityId: assessmentRequestId,
        actionUrl: `/ops/drafts/${draft.id}`, dedupeKey: `assessment-requested:${assessmentRequestId}`,
      });
      await query(
        `INSERT INTO business_audit_events (organization_id,actor_id,action,object_type,object_id,after_state)
         VALUES ($1,$2,'ASSESSMENT_REQUESTED','TASK_DRAFT',$3,$4::jsonb)`,
        [input.organizationId,input.actorId,draft.id,JSON.stringify({ assessmentRequestId,
          providerOsRelationshipId: relationship.id, source: 'PROVIDER_OS',
          proposedWindowStart: windowStart.toISOString(), proposedWindowEnd: windowEnd.toISOString() })],
      );
      return { success: true as const, data: { assessmentRequestId, taskDraftId: draft.id, status: 'PENDING_ADMIN' as const } };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'FORBIDDEN') throw error;
    log.error({ action: 'providerOs.requestAssessment', draftId: input.draftId,
      organizationId: input.organizationId, actorId: input.actorId,
      ...assessmentFailureDetails(error) }, 'Provider OS assessment transaction failed');
    return { success: false as const, error: { code: 'ASSESSMENT_REQUEST_FAILED', message: 'Unable to submit the assessment request.' } };
  }
}
