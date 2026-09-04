import crypto from 'node:crypto';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

interface ClaimInput {
  token: string;
  organizationId: string;
  serviceProfileId: string;
  businessLocationId: string;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
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
        status: string;
        quote_id: string | null;
      }>(
        `
        SELECT id, category, title, scope_summary, status, quote_id
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

      if (
        !org ||
        org.status !== 'ACTIVE' ||
        org.provider_enabled !== true
      ) {
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
	  !['DRAFT', 'ACTIVE'].includes(profile.status) ||
	  profile.service_code.trim().toLowerCase() !== draft.category.trim().toLowerCase()
      ) {
        return failure(
          'SERVICE_PROFILE_MISMATCH',
          'The selected service profile cannot perform this task category.',
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
      const existingBusinessQuote = await query<{ id: string }>(
        `
        SELECT id
        FROM quotes
        WHERE task_draft_id = $1
          AND business_organization_id = $2
          AND status NOT IN ('rejected', 'withdrawn', 'expired', 'superseded')
        LIMIT 1
        `,
        [draft.id, input.organizationId],
      );

      if (existingBusinessQuote.rows[0]) {
        return failure(
          'BUSINESS_ALREADY_QUOTED',
          'This business already has an active quote for this task.',
        );
      }
      const platformMarginCents =
        input.proposedCustomerTotalCents - input.proposedPayoutCents;

      /*
       * Create the quote that the existing payment finalizer already knows
       * how to turn into a canonical task.
       */
      const quoteResult = await query<{ id: string }>(
      `
      INSERT INTO quotes (
        task_draft_id,
        title,
        status,
        environment,
        is_test,
        business_organization_id,
        business_location_id,
        provider_service_profile_id,
        claimed_by_user_id
      )
      VALUES ($1, $2, 'submitted', 'TEST', TRUE, $3, $4, $5, $6)
      RETURNING id
      `,
          [
            draft.id,
            draft.title ?? 'Business Quote',
            input.organizationId,
            input.businessLocationId,
            input.serviceProfileId,
            input.actorId,
          ],
        );
    const now = new Date();

    const arrivalWindowStart = new Date(
      now.getTime() + 48 * 60 * 60 * 1000,
    );

    const arrivalWindowEnd = new Date(
      now.getTime() + 120 * 60 * 60 * 1000,
    );

    const dispatchExpiresAt = new Date(
      arrivalWindowStart.getTime() - 2 * 60 * 60 * 1000,
    );
        const quoteId = quoteResult.rows[0]?.id;

        if (!quoteId) {
          return failure(
            'QUOTE_CREATE_FAILED',
            'Unable to create the business quote.',
          );
        }

        const payToken = crypto.randomBytes(16).toString('hex');
        const quoteExpiresAt = link.expires_at;
        const versionResult = await query<{ id: string }>(
      `
      INSERT INTO quote_versions (
        quote_id,
        version_number,
        status,
        customer_description,
        subtotal_cents,
        service_fee_cents,
        materials_cents,
        discount_cents,
        total_cents,
        hustler_payout_cents,
        scope_json,
        pay_token,
        arrival_window_start,
        arrival_window_end,
        expires_at,
        dispatch_expires_at
      )
      VALUES (
        $1, 1, 'draft', $2,
        $3, 0, 0, 0,
        $3, $4, $5::jsonb, $6,
        $7, $8, $9, $10
      )
      RETURNING id
      `,
      [
        quoteId,
        draft.scope_summary ?? draft.title ?? 'Task',
        input.proposedCustomerTotalCents,
        input.proposedPayoutCents,
        JSON.stringify({
          business_claim: true,
          business_organization_id: input.organizationId,
          business_service_profile_id: input.serviceProfileId,
          business_location_id: input.businessLocationId,
          platform_margin_cents: platformMarginCents,
        }),
        payToken,
        arrivalWindowStart,
        arrivalWindowEnd,
        quoteExpiresAt,
        dispatchExpiresAt,
      ],
    );

      const quoteVersionId = versionResult.rows[0]?.id;

      if (!quoteVersionId) {
        return failure(
          'QUOTE_VERSION_CREATE_FAILED',
          'Unable to create business quote version.',
        );
      }

      await query(
        `
        UPDATE quotes
        SET active_version_id = $1,
            updated_at = NOW()
        WHERE id = $2
        `,
        [quoteVersionId, quoteId],
      );

      

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
          input.proposedCustomerTotalCents,
          input.proposedPayoutCents,
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
          customerTotalCents: input.proposedCustomerTotalCents,
          payoutCents: input.proposedPayoutCents,
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
