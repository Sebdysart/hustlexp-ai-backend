import crypto from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { assertVerifiedProvider } from './BusinessWorkspacePolicy.js';
import { NotificationService } from './NotificationService.js';

interface ClaimInput {
  token: string;
  organizationId: string;
  serviceProfileId: string;
  businessLocationId: string;

  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;

  arrivalWindowStart: string;
  arrivalWindowEnd: string;

  actorId: string;
}

interface ClaimResult {
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
  draft: { id: string; title: string | null; scope_summary: string | null; poster_user_id: string };
  organizationId: string;
  actorId: string;
  serviceProfileId: string;
  businessLocationId: string;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
  arrivalWindowStart: string;
  arrivalWindowEnd: string;
  quoteExpiresAt: Date;
};

async function createBusinessQuoteInTransaction(
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
       provider_service_profile_id, claimed_by_user_id
     ) VALUES ($1, $2, 'submitted', 'TEST', TRUE, $3, $4, $5, $6)
     RETURNING id`,
    [input.draft.id, input.draft.title ?? 'Business Quote', input.organizationId, input.businessLocationId, input.serviceProfileId, input.actorId],
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
      JSON.stringify({ business_claim: true, business_organization_id: input.organizationId, business_service_profile_id: input.serviceProfileId, business_location_id: input.businessLocationId, platform_margin_cents: platformMarginCents }),
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
  console.log('[QUOTE_NOTIFICATION_DEBUG]', {
    posterUserId: input.draft.poster_user_id,
    draftId: input.draft.id,
    quoteId,
    organizationId: input.organizationId,
  });
  await NotificationService.createInTransaction(query, {
    userId: input.draft.poster_user_id,
    type: 'QUOTE_RECEIVED',
    title: 'New quote received',
    message: 'A business sent you a quote.',
    entityType: 'quote',
    entityId: quoteId,
    actionUrl: `/dashboard/drafts/${input.draft.id}`,
    dedupeKey: `quote-created:${quoteId}`,
  });
  return { success: true as const, data: { quoteId, quoteVersionId, customerTotalCents: input.proposedCustomerTotalCents, payoutCents: input.proposedPayoutCents, platformMarginCents } };
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
      }>(
        `
        SELECT id, category, title, scope_summary, status, quote_id, poster_user_id
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


      if (draft.status === 'abandoned') {
        return failure(
          'TASK_DRAFT_UNAVAILABLE',
          'This task is no longer available.',
        );
      }

      /*
       * Business membership / authority.
       */
      await query(
        `
        SELECT business_require_action($1, $2, 'ASSIGN_CREW')
        `,
        [input.organizationId, input.actorId],
      );

      /*
       * Organization must be a verified provider.
       */
      const orgResult = await query<{
        id: string;
        status: string;
        provider_enabled: boolean;
        verification_status: string;
      }>(
        `
        SELECT id, status, provider_enabled, verification_status
        FROM business_organizations
        WHERE id = $1
        FOR SHARE
        `,
        [input.organizationId],
      );

      const org = orgResult.rows[0];

      if (!org) {
        return failure(
          'BUSINESS_NOT_READY',
          'The business organization is not currently eligible to claim work.',
        );
      }

      try {
        assertVerifiedProvider({
          status: org.status,
          verificationStatus: org.verification_status,
          providerEnabled: org.provider_enabled,
        });
      } catch {
        return failure(
          'BUSINESS_NOT_READY',
          'The business organization is not currently eligible to claim work.',
        );
      }

      /*
       * Service profile must match the task category.
       */
      const profileResult = await query<{
        id: string;
        organization_id: string;
        service_code: string;
        status: string;
      }>(
        `
        SELECT id, organization_id, service_code, status
        FROM business_service_profiles
        WHERE id = $1
          AND organization_id = $2
        FOR SHARE
        `,
        [input.serviceProfileId, input.organizationId],
      );

      const profile = profileResult.rows[0];

      if (
        !profile ||
        !['DRAFT', 'ACTIVE'].includes(profile.status)
      ) {
        return failure(
          'SERVICE_PROFILE_UNAVAILABLE',
          'The selected service profile is not available.',
        );
      }

      /*
       * Business location must belong to the same organization.
       */
      const locationResult = await query<{
        id: string;
        organization_id: string;
        status: string;
      }>(
        `
        SELECT id, organization_id, status
        FROM business_locations
        WHERE id = $1
          AND organization_id = $2
        FOR SHARE
        `,
        [input.businessLocationId, input.organizationId],
      );

      const location = locationResult.rows[0];

      if (!location || location.status !== 'ACTIVE') {
        return failure(
          'BUSINESS_LOCATION_INVALID',
          'The selected business location is not active.',
        );
      }
      const quoteCreateResult = await createBusinessQuoteInTransaction(query, {
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
          input.serviceProfileId,
          input.businessLocationId,
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
  serviceProfileId: string;
  businessLocationId: string;
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
        claim_link_id: string;
        status: string;
        assessment_credit_cents: number | null;
      }>(
        `SELECT assessment.id, assessment.task_draft_id, assessment.business_organization_id, assessment.claim_link_id, assessment.status,
                payment.amount_cents AS assessment_credit_cents,
                
         FROM business_assessment_requests assessment
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id AND payment.status = 'SUCCEEDED'
         WHERE assessment.id = $1 FOR UPDATE`,
        [input.assessmentRequestId],
      );
      const assessment = assessmentResult.rows[0];
      if (!assessment || assessment.status !== 'COMPLETED') {
        return failure('ASSESSMENT_NOT_COMPLETED', 'The in-person assessment must be completed before a quote can be submitted.');
      }
      if (assessment.business_organization_id !== input.organizationId) {
        return failure('ASSESSMENT_WRONG_BUSINESS', 'This assessment belongs to another business.');
      }
      const assessmentCreditCents = assessment.assessment_credit_cents ?? 0;
      if (assessmentCreditCents > 0 && input.proposedCustomerTotalCents <= assessmentCreditCents) return failure('QUOTE_TOTAL_NOT_ABOVE_ASSESSMENT_CREDIT', 'The final quote total must exceed the assessment credit.');

      await query(`SELECT business_require_action($1, $2, 'ASSIGN_CREW')`, [input.organizationId, input.actorId]);
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

      const claimResult = await query<{ id: string; status: string; claimed_by_organization_id: string | null; quote_id: string | null }>(
        `SELECT id, status, claimed_by_organization_id, quote_id
         FROM ops_business_claim_links WHERE id = $1 FOR UPDATE`,
        [assessment.claim_link_id],
      );
      const claim = claimResult.rows[0];
      if (!claim || claim.status !== 'CLAIMED') return failure('CLAIM_NOT_AVAILABLE', 'The associated business claim is no longer available.');
      if (claim.claimed_by_organization_id !== input.organizationId) return failure('CLAIM_WRONG_BUSINESS', 'This claim belongs to another business.');
      if (claim.quote_id) return failure('CLAIM_ALREADY_QUOTED', 'A quote has already been submitted for this claim.');

      const profileResult = await query<{ id: string; status: string }>(
        `SELECT id, status FROM business_service_profiles
         WHERE id = $1 AND organization_id = $2 FOR SHARE`,
        [input.serviceProfileId, input.organizationId],
      );
      const profile = profileResult.rows[0];
      if (!profile || !['DRAFT', 'ACTIVE'].includes(profile.status)) return failure('SERVICE_PROFILE_UNAVAILABLE', 'The selected service profile is not available.');

      const locationResult = await query<{ id: string; status: string }>(
        `SELECT id, status FROM business_locations
         WHERE id = $1 AND organization_id = $2 FOR SHARE`,
        [input.businessLocationId, input.organizationId],
      );
      const location = locationResult.rows[0];
      if (!location || location.status !== 'ACTIVE') return failure('BUSINESS_LOCATION_INVALID', 'The selected business location is not active.');

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
        draft,
        organizationId: input.organizationId,
        actorId: input.actorId,
        serviceProfileId: input.serviceProfileId,
        businessLocationId: input.businessLocationId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
        quoteExpiresAt,
      });
      if (!quoteCreateResult.success) return failure(quoteCreateResult.error.code, quoteCreateResult.error.message);

      const { quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents } = quoteCreateResult.data;
      const claimUpdated = await query<{ id: string }>(
        `UPDATE ops_business_claim_links
         SET claimed_by_service_profile_id = $2, claimed_by_business_location_id = $3,
             proposed_customer_total_cents = $4, proposed_payout_cents = $5,
             quote_id = $6, updated_at = NOW()
         WHERE id = $1 AND status = 'CLAIMED' AND quote_id IS NULL RETURNING id`,
        [claim.id, input.serviceProfileId, input.businessLocationId, customerTotalCents, payoutCents, quoteId],
      );
      if (!claimUpdated.rows[0]) throw new Error('POST_ASSESSMENT_QUOTE_RACE_LOST');

      await query(
        `INSERT INTO business_audit_events (organization_id, actor_id, action, object_type, object_id, after_state)
         VALUES ($1, $2, 'POST_ASSESSMENT_QUOTE_SUBMITTED', 'TASK_DRAFT', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, draft.id, JSON.stringify({ assessmentRequestId: assessment.id, quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents })],
      );
      return { success: true as const, data: { assessmentRequestId: assessment.id, taskDraftId: draft.id, quoteId, quoteVersionId, customerTotalCents, payoutCents, platformMarginCents, expiresAt: quoteExpiresAt.toISOString() } };
    });
  } catch {
    return failure('POST_ASSESSMENT_QUOTE_FAILED', 'Unable to submit the post-assessment quote.');
  }
}
