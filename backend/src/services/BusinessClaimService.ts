import crypto from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { assertVerifiedProvider } from './BusinessWorkspacePolicy.js';
import { logger } from '../logger.js';
import { PENDING_BUSINESS_VERIFICATION, publishBusinessQuoteInTransaction } from './BusinessQuoteActivationService.js';

interface ClaimInput {
  token: string;
  organizationId: string;
  serviceProfileId?: string;
  businessLocationId?: string;

  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;

  arrivalWindowStart: string;
  arrivalWindowEnd: string;

  actorId: string;
}

interface ClaimResult {
  quoteStatus: 'submitted' | typeof PENDING_BUSINESS_VERIFICATION;
  claimLinkId: string;
  taskDraftId: string;
  quoteId: string;
  quoteVersionId: string;
  customerTotalCents: number;
  payoutCents: number;
  platformMarginCents: number;
  expiresAt: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

function failure(code: string, message: string): ServiceResult<never> {
  return {
    success: false,
    error: { code, message },
  };
}

type CreateBusinessQuoteInput = {
  acquisitionOrigin: 'claim_link' | 'direct_proposal' | 'provider_os';
  draft: { id: string; title: string | null; scope_summary: string | null; poster_user_id: string };
  organizationId: string;
  actorId: string;
  serviceProfileId?: string;
  businessLocationId?: string;
  pendingBusinessVerification?: boolean;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
  assessmentCreditCents?: number;
  grossCustomerTotalCents?: number;
  arrivalWindowStart: string;
  arrivalWindowEnd: string;
  quoteExpiresAt: Date;
};

type ValidateBusinessQuoteContextInput = {
  organizationId: string;
  actorId: string;
  serviceProfileId?: string;
  businessLocationId?: string;
  allowPendingVerification?: boolean;
};

type ValidatedBusinessQuoteContext = {
  organizationId: string;
  pendingBusinessVerification: boolean;
};

export async function validateBusinessQuoteContext(
  query: QueryFn,
  input: ValidateBusinessQuoteContextInput,
): Promise<ServiceResult<ValidatedBusinessQuoteContext>> {
  await query(`SELECT business_require_action($1, $2, 'ASSIGN_CREW')`, [input.organizationId, input.actorId]);
  const orgResult = await query<{ id: string; status: string; provider_enabled: boolean; verification_status: string; legal_name: string; display_name: string; washington_ubi: string | null; federal_ein: string | null }>(
    `SELECT id, status, provider_enabled, verification_status, legal_name, display_name, washington_ubi, federal_ein
     FROM business_organizations WHERE id = $1 FOR SHARE`,
    [input.organizationId],
  );
  const org = orgResult.rows[0];
  if (!org) return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to claim work.');
  try {
    if (input.allowPendingVerification && ['UNVERIFIED', 'PENDING'].includes(org.verification_status)) {
      if (org.status !== 'ACTIVE' || !org.provider_enabled || !org.legal_name?.trim() || !org.display_name?.trim()
          || !/^\d{9}$/.test(org.washington_ubi ?? '') || !/^\d{9}$/.test(org.federal_ein ?? '')) {
        return failure('BUSINESS_NOT_READY', 'Complete your business identity information before submitting a quote.');
      }
    } else {
      assertVerifiedProvider({ status: org.status, verificationStatus: org.verification_status, providerEnabled: org.provider_enabled });
    }
  } catch {
    return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to claim work.');
  }
  // Service profiles and business locations are dormant for launch. Legacy
  // clients may still send their IDs, but they neither grant authority nor bind
  // new marketplace quotes to dormant configuration.
  return { success: true, data: { organizationId: input.organizationId, pendingBusinessVerification: org.verification_status !== 'VERIFIED' } };
}

export async function createBusinessQuoteInTransaction(
  query: QueryFn,
  input: CreateBusinessQuoteInput,
) {
  if (!Number.isInteger(input.proposedCustomerTotalCents) || input.proposedCustomerTotalCents <= 0) {
    return { success: false as const, error: { code: 'INVALID_CUSTOMER_TOTAL', message: 'Customer total must be a positive amount.' } };
  }
  if (!Number.isInteger(input.proposedPayoutCents) || input.proposedPayoutCents <= 0) {
    return { success: false as const, error: { code: 'INVALID_PROVIDER_PAYOUT', message: 'Provider payout must be a positive amount.' } };
  }
  if (input.proposedPayoutCents > input.proposedCustomerTotalCents) {
    return { success: false as const, error: { code: 'INVALID_QUOTE_ECONOMICS', message: 'Provider payout cannot exceed the customer total.' } };
  }

  const arrivalWindowStart = new Date(input.arrivalWindowStart);
  const arrivalWindowEnd = new Date(input.arrivalWindowEnd);
  if (!Number.isFinite(arrivalWindowStart.getTime()) || !Number.isFinite(arrivalWindowEnd.getTime()) || arrivalWindowEnd <= arrivalWindowStart) {
    return { success: false as const, error: { code: 'INVALID_ARRIVAL_WINDOW', message: 'The proposed arrival window is invalid.' } };
  }

  const existingBusinessQuote = await query<{ id: string }>(
    `SELECT id FROM quotes
     WHERE task_draft_id = $1 AND business_organization_id = $2
       AND status NOT IN ('rejected', 'withdrawn', 'expired', 'superseded')
     LIMIT 1`,
    [input.draft.id, input.organizationId],
  );
  if (existingBusinessQuote.rows[0]) {
    return { success: false as const, error: { code: 'BUSINESS_ALREADY_QUOTED', message: 'This business already has an active quote for this task.' } };
  }

  const platformMarginCents = input.proposedCustomerTotalCents - input.proposedPayoutCents;
  const quoteResult = await query<{ id: string }>(
    `INSERT INTO quotes (
       task_draft_id, title, status, environment, is_test,
       business_organization_id, business_location_id,
       provider_service_profile_id, claimed_by_user_id, acquisition_origin
     ) VALUES ($1, $2, $5, 'TEST', TRUE, $3, NULL, NULL, $4, $6)
     RETURNING id`,
    [input.draft.id, input.draft.title ?? 'Business Quote', input.organizationId, input.actorId,
      input.pendingBusinessVerification ? PENDING_BUSINESS_VERIFICATION : 'draft', input.acquisitionOrigin],
  );
  const quoteId = quoteResult.rows[0]?.id;
  if (!quoteId) return { success: false as const, error: { code: 'QUOTE_CREATE_FAILED', message: 'Unable to create the business quote.' } };

  const dispatchExpiresAt = new Date(arrivalWindowStart.getTime() - 2 * 60 * 60 * 1000);
  const payToken = crypto.randomBytes(16).toString('hex');
  const versionResult = await query<{ id: string }>(
    `INSERT INTO quote_versions (
       quote_id, version_number, status, customer_description,
       subtotal_cents, service_fee_cents, materials_cents, discount_cents,
       total_cents, hustler_payout_cents, scope_json, pay_token,
       arrival_window_start, arrival_window_end, expires_at, dispatch_expires_at
     ) VALUES ($1, 1, 'draft', $2, $3, 0, 0, 0, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      quoteId,
      input.draft.scope_summary ?? input.draft.title ?? 'Task',
      input.proposedCustomerTotalCents,
      input.proposedPayoutCents,
      JSON.stringify({ acquisition_origin: input.acquisitionOrigin, business_claim: input.acquisitionOrigin === 'claim_link', business_organization_id: input.organizationId, platform_margin_cents: platformMarginCents,
        ...(input.assessmentCreditCents ? { assessment_credit_cents: input.assessmentCreditCents, gross_customer_total_cents: input.grossCustomerTotalCents } : {}) }),
      payToken,
      arrivalWindowStart,
      arrivalWindowEnd,
      input.quoteExpiresAt,
      dispatchExpiresAt,
    ],
  );
  const quoteVersionId = versionResult.rows[0]?.id;
  if (!quoteVersionId) return { success: false as const, error: { code: 'QUOTE_VERSION_CREATE_FAILED', message: 'Unable to create business quote version.' } };

  await query(`UPDATE quotes SET active_version_id = $1, updated_at = NOW() WHERE id = $2`, [quoteVersionId, quoteId]);
  if (!input.pendingBusinessVerification) {
    const published = await publishBusinessQuoteInTransaction(query, {
      quoteId, taskDraftId: input.draft.id, posterUserId: input.draft.poster_user_id, fromStatus: 'draft',
    });
    if (!published) throw new Error('BUSINESS_QUOTE_ACTIVATION_FAILED');
  }
  const quoteStatus = input.pendingBusinessVerification ? PENDING_BUSINESS_VERIFICATION : 'submitted' as const;
  return { success: true as const, data: { quoteId, quoteVersionId, quoteStatus, customerTotalCents: input.proposedCustomerTotalCents, payoutCents: input.proposedPayoutCents, platformMarginCents } };
}

export async function claimBusinessTask(
  input: ClaimInput,
): Promise<ServiceResult<ClaimResult>> {
  if (
    !Number.isInteger(input.proposedCustomerTotalCents) ||
    input.proposedCustomerTotalCents <= 0 ||
    !Number.isInteger(input.proposedPayoutCents) ||
    input.proposedPayoutCents <= 0 ||
    input.proposedPayoutCents > input.proposedCustomerTotalCents
  ) {
    return failure(
      'INVALID_PRICING',
      'Customer price and business payout must be valid integer cents, with payout no greater than customer price.',
    );
  }

  const tokenHash = hashToken(input.token);

  try {
    return await db.transaction(async (query) => {
      // Lock the organization before the link/draft, matching verification release.
      const businessContext = await validateBusinessQuoteContext(query, {
        organizationId: input.organizationId, actorId: input.actorId, allowPendingVerification: true,
      });
      if (!businessContext.success) return businessContext;
      const linkResult = await query<{
        id: string;
        task_draft_id: string;
        status: string;
        expires_at: Date;
      }>(
        `
        SELECT id, task_draft_id, status, expires_at
        FROM ops_business_claim_links
        WHERE token_hash = $1
        FOR UPDATE
        `,
        [tokenHash],
      );

      const link = linkResult.rows[0];

      if (!link || link.status !== 'OPEN') {
        return failure(
          'CLAIM_LINK_UNAVAILABLE',
          'This claim link is invalid or no longer available.',
        );
      }

      if (link.expires_at <= new Date()) {
        await query(
          `
          UPDATE ops_business_claim_links
          SET status = 'EXPIRED', updated_at = NOW()
          WHERE id = $1 AND status = 'OPEN'
          `,
          [link.id],
        );

        return failure(
          'CLAIM_LINK_EXPIRED',
          'This claim link has expired.',
        );
      }

      const draftResult = await query<{
        id: string;
        category: string;
        title: string | null;
        scope_summary: string | null;
        poster_user_id: string;
        status: string;
        quote_id: string | null;
        task_id: string | null;
      }>(
        `
        SELECT id, category, title, scope_summary, status, quote_id, poster_user_id, task_id
        FROM task_drafts
        WHERE id = $1
        FOR UPDATE
        `,
        [link.task_draft_id],
      );

      const draft = draftResult.rows[0];

      if (!draft) {
        return failure('TASK_DRAFT_NOT_FOUND', 'Task draft no longer exists.');
      }


      if (draft.status === 'abandoned' || draft.quote_id || draft.task_id) {
        return failure(
          'TASK_DRAFT_UNAVAILABLE',
          'This task is no longer available.',
        );
      }

      const quoteCreateResult = await createBusinessQuoteInTransaction(query, {
        acquisitionOrigin: 'claim_link',
        draft,
        organizationId: input.organizationId,
        actorId: input.actorId,
        serviceProfileId: input.serviceProfileId,
        businessLocationId: input.businessLocationId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
        quoteExpiresAt: link.expires_at,
        pendingBusinessVerification: businessContext.data.pendingBusinessVerification,
      });

      if (!quoteCreateResult.success) {
        return failure(quoteCreateResult.error.code, quoteCreateResult.error.message);
      }

      const {
        quoteId,
        quoteVersionId,
        customerTotalCents,
        payoutCents,
        platformMarginCents,
      } = quoteCreateResult.data;

      const claimed = await query<{ id: string }>(
        `
        UPDATE ops_business_claim_links
        SET
          status = 'CLAIMED',
          claimed_by_organization_id = $2,
          claimed_by_business_user_id = $3,
          claimed_by_service_profile_id = $4,
          claimed_by_business_location_id = $5,
          proposed_customer_total_cents = $6,
          proposed_payout_cents = $7,
          quote_id = $8,
          claimed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND status = 'OPEN'
          AND expires_at > NOW()
        RETURNING id
        `,
        [
          link.id,
          input.organizationId,
          input.actorId,
          null,
          null,
          customerTotalCents,
          payoutCents,
          quoteId,
        ],
      );

      if (!claimed.rows[0]) {
        throw new Error('CLAIM_RACE_LOST');
      }

      await query(
        `
        INSERT INTO business_audit_events (
          organization_id,
          actor_id,
          action,
          object_type,
          object_id,
          after_state
        )
        VALUES ($1, $2, 'TASK_CLAIMED', 'TASK_DRAFT', $3, $4::jsonb)
        `,
        [
          input.organizationId,
          input.actorId,
          draft.id,
          JSON.stringify({
            quoteId,
            quoteVersionId,
            customerTotalCents: input.proposedCustomerTotalCents,
            payoutCents: input.proposedPayoutCents,
          }),
        ],
      );

      return {
        success: true,
        data: {
          claimLinkId: link.id,
          taskDraftId: draft.id,
          quoteId,
          quoteVersionId,
          quoteStatus: quoteCreateResult.data.quoteStatus,
          customerTotalCents,
          payoutCents,
          platformMarginCents,
          expiresAt: link.expires_at.toISOString(),
        },
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'CLAIM_RACE_LOST') {
      return failure(
        'CLAIM_RACE_LOST',
        'Another business claimed this task first.',
      );
    }

    return failure(
      'BUSINESS_CLAIM_FAILED',
      'Unable to claim this task.',
    );
  }
}

export async function quoteAfterAssessment(input: {
  assessmentRequestId: string;
  organizationId: string;
  actorId: string;
  serviceProfileId?: string;
  businessLocationId?: string;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
  arrivalWindowStart: string;
  arrivalWindowEnd: string;
}) {
  try {
    return await db.transaction(async (query) => {
      const assessmentResult = await query<{
        id: string;
        task_draft_id: string;
        business_organization_id: string;
        claim_link_id: string | null;
        proposal_id: string | null;
        quote_id: string | null;
        assessment_fee_cents: number | null;
        status: string;
      }>(
        `SELECT id, task_draft_id, business_organization_id, claim_link_id, proposal_id,
                quote_id, assessment_fee_cents, status
         FROM business_assessment_requests WHERE id = $1 FOR UPDATE`,
        [input.assessmentRequestId],
      );
      const assessment = assessmentResult.rows[0];
      if (!assessment || assessment.status !== 'COMPLETED') {
        return failure('ASSESSMENT_NOT_COMPLETED', 'The in-person assessment must be completed before a quote can be submitted.');
      }
      if (assessment.business_organization_id !== input.organizationId) {
        return failure('ASSESSMENT_WRONG_BUSINESS', 'This assessment belongs to another business.');
      }
      await query(`SELECT business_require_action($1, $2, 'ASSIGN_CREW')`, [input.organizationId, input.actorId]);
      if (assessment.quote_id) {
        const existing = await query<{ id: string; version_id: string; total_cents: number; payout_cents: number; expires_at: Date }>(
          `SELECT q.id,v.id AS version_id,v.total_cents,v.hustler_payout_cents AS payout_cents,v.expires_at
           FROM quotes q JOIN quote_versions v ON v.id=q.active_version_id
           WHERE q.id=$1 AND q.business_organization_id=$2 AND q.task_draft_id=$3`,
          [assessment.quote_id,input.organizationId,assessment.task_draft_id],
        );
        const row = existing.rows[0];
        if (!row) return failure('ASSESSMENT_ALREADY_QUOTED', 'The assessment quote is unavailable.');
        return { success: true as const, data: { assessmentRequestId: assessment.id, taskDraftId: assessment.task_draft_id,
          quoteId: row.id, quoteVersionId: row.version_id, customerTotalCents: row.total_cents,
          payoutCents: row.payout_cents, platformMarginCents: row.total_cents-row.payout_cents,
          expiresAt: row.expires_at.toISOString(), replayed: true } };
      }
      if (Boolean(assessment.claim_link_id) === Boolean(assessment.proposal_id)) {
        return failure('ASSESSMENT_ORIGIN_INVALID', 'The assessment acquisition source is unavailable.');
      }
      const payment = await query<{ amount_cents: number }>(
        `SELECT amount_cents FROM assessment_payments
         WHERE assessment_request_id = $1 AND status = 'SUCCEEDED' FOR SHARE`,
        [assessment.id],
      );
      const assessmentCreditCents = payment.rows[0]?.amount_cents ?? 0;
      if ((assessment.assessment_fee_cents ?? 0) > 0 && assessmentCreditCents !== assessment.assessment_fee_cents) {
        return failure('ASSESSMENT_PAYMENT_REQUIRED', 'The assessment payment must be confirmed before quoting.');
      }
      if (assessmentCreditCents > 0 && input.proposedCustomerTotalCents <= assessmentCreditCents) return failure('QUOTE_TOTAL_NOT_ABOVE_ASSESSMENT_CREDIT', 'The final quote total must exceed the assessment credit.');
      if (assessmentCreditCents > 0 && input.proposedPayoutCents <= assessmentCreditCents) return failure('QUOTE_PAYOUT_NOT_ABOVE_ASSESSMENT_CREDIT', 'The provider payout must exceed the assessment amount already paid.');
      // The business already received the assessment fee. The canonical quote,
      // task and escrow represent only the remaining customer/payment balance.
      const netCustomerTotalCents = input.proposedCustomerTotalCents - assessmentCreditCents;
      const netPayoutCents = input.proposedPayoutCents - assessmentCreditCents;

      const orgResult = await query<{ status: string; provider_enabled: boolean; verification_status: string }>(
        `SELECT status, provider_enabled, verification_status FROM business_organizations WHERE id = $1 FOR SHARE`,
        [input.organizationId],
      );
      const org = orgResult.rows[0];
      if (!org) return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to quote work.');
      try {
        assertVerifiedProvider({ status: org.status, verificationStatus: org.verification_status, providerEnabled: org.provider_enabled });
      } catch {
        return failure('BUSINESS_NOT_READY', 'The business organization is not currently eligible to quote work.');
      }

      const draftResult = await query<{ id: string; title: string | null; scope_summary: string | null; poster_user_id: string; status: string; task_id: string | null }>(
        `SELECT id, title, scope_summary, poster_user_id, status, task_id FROM task_drafts WHERE id = $1 FOR UPDATE`,
        [assessment.task_draft_id],
      );
      const draft = draftResult.rows[0];
      if (!draft) return failure('TASK_DRAFT_NOT_FOUND', 'Task draft no longer exists.');
      if (draft.status === 'abandoned' || draft.task_id) return failure('TASK_DRAFT_UNAVAILABLE', 'This task is no longer available for quoting.');

      let acquisitionOrigin: 'claim_link' | 'direct_proposal';
      if (assessment.claim_link_id) {
        const claimResult = await query<{ id: string; status: string; task_draft_id: string; claimed_by_organization_id: string | null; quote_id: string | null }>(
          `SELECT id, status, task_draft_id, claimed_by_organization_id, quote_id
           FROM ops_business_claim_links WHERE id = $1 FOR UPDATE`,
          [assessment.claim_link_id],
        );
        const claim = claimResult.rows[0];
        if (!claim || claim.status !== 'CLAIMED' || claim.task_draft_id !== draft.id ||
            claim.claimed_by_organization_id !== input.organizationId || claim.quote_id) {
          return failure('CLAIM_NOT_AVAILABLE', 'The associated business claim is no longer available.');
        }
        acquisitionOrigin = 'claim_link';
      } else {
        const proposalResult = await query<{ id: string; task_draft_id: string; business_organization_id: string; status: string; quote_id: string | null }>(
          `SELECT id, task_draft_id, business_organization_id, status, quote_id
           FROM business_task_proposals WHERE id = $1 FOR UPDATE`,
          [assessment.proposal_id],
        );
        const proposal = proposalResult.rows[0];
        if (!proposal || proposal.task_draft_id !== draft.id || proposal.business_organization_id !== input.organizationId ||
            !['PENDING', 'VIEWED', 'EXPIRED'].includes(proposal.status) || proposal.quote_id) {
          return failure('PROPOSAL_NOT_AVAILABLE', 'The associated business proposal is no longer available.');
        }
        acquisitionOrigin = 'direct_proposal';
      }

      const arrivalStart = new Date(input.arrivalWindowStart);
      const arrivalEnd = new Date(input.arrivalWindowEnd);
      if (!Number.isFinite(arrivalStart.getTime()) || !Number.isFinite(arrivalEnd.getTime()) || arrivalEnd <= arrivalStart) {
        return failure('INVALID_ARRIVAL_WINDOW', 'The proposed arrival window is invalid.');
      }
      const defaultQuoteExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const dispatchExpiry = new Date(arrivalStart.getTime() - 2 * 60 * 60 * 1000);
      const quoteExpiresAt = defaultQuoteExpiry < dispatchExpiry ? defaultQuoteExpiry : dispatchExpiry;
      if (quoteExpiresAt <= new Date()) return failure('QUOTE_WINDOW_TOO_SOON', 'The proposed service window is too soon to create this quote.');

      const quoteCreateResult = await createBusinessQuoteInTransaction(query, {
        acquisitionOrigin,
        draft,
        organizationId: input.organizationId,
        actorId: input.actorId,
        serviceProfileId: input.serviceProfileId,
        businessLocationId: input.businessLocationId,
        proposedCustomerTotalCents: netCustomerTotalCents,
        proposedPayoutCents: netPayoutCents,
        assessmentCreditCents,
        grossCustomerTotalCents: input.proposedCustomerTotalCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
        quoteExpiresAt,
      });
      if (!quoteCreateResult.success) return failure(quoteCreateResult.error.code, quoteCreateResult.error.message);

      const { quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents } = quoteCreateResult.data;
      if (assessment.claim_link_id) {
        const updated = await query<{ id: string }>(
          `UPDATE ops_business_claim_links SET claimed_by_service_profile_id = NULL,
             claimed_by_business_location_id = NULL, proposed_customer_total_cents = $2,
             proposed_payout_cents = $3, quote_id = $4, updated_at = NOW()
           WHERE id = $1 AND status = 'CLAIMED' AND quote_id IS NULL RETURNING id`,
          [assessment.claim_link_id, customerTotalCents, payoutCents, quoteId],
        );
        if (!updated.rows[0]) throw new Error('POST_ASSESSMENT_QUOTE_RACE_LOST');
      } else {
        const updated = await query<{ id: string }>(
          `UPDATE business_task_proposals SET status = 'QUOTED', quote_id = $2,
             responded_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status IN ('PENDING', 'VIEWED', 'EXPIRED') AND quote_id IS NULL RETURNING id`,
          [assessment.proposal_id, quoteId],
        );
        if (!updated.rows[0]) throw new Error('POST_ASSESSMENT_PROPOSAL_RACE_LOST');
      }
      await query('UPDATE business_assessment_requests SET quote_id = $2, quote_is_net_of_credit = TRUE, updated_at = NOW() WHERE id = $1',
        [assessment.id, quoteId]);

      await query(
        `INSERT INTO business_audit_events (organization_id, actor_id, action, object_type, object_id, after_state)
         VALUES ($1, $2, 'POST_ASSESSMENT_QUOTE_SUBMITTED', 'TASK_DRAFT', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, draft.id, JSON.stringify({ assessmentRequestId: assessment.id, quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents })],
      );
      return { success: true as const, data: { assessmentRequestId: assessment.id, taskDraftId: draft.id, quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents, expiresAt: quoteExpiresAt.toISOString() } };
    });
  } catch (error) {
    logger.error({ err: error, assessmentRequestId: input.assessmentRequestId,
      organizationId: input.organizationId }, 'Post-assessment quote transaction failed');
    return failure('POST_ASSESSMENT_QUOTE_FAILED', 'Unable to submit the post-assessment quote.');
  }
}
