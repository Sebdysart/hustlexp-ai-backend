import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { assertProviderOsAccess, providerOsOrganizationState } from './ProviderOsAccess.js';
import {
  createBusinessQuoteInTransaction,
  validateBusinessQuoteContext,
} from './BusinessClaimService.js';
import { getTaskFactsForDisplay } from './taskIntake/getTaskFactsForDisplay.js';
import { computePreferredArrivalWindow } from './QuoteTiming.js';
import {
  isProviderOsEligibleDraft,
  isProviderOsInviteToken,
  normalizePosterEmail,
  PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES,
  PROVIDER_OS_INVITE_TTL_DAYS,
} from './ProviderOsPolicy.js';

export interface ProviderOsClient {
  relationshipId: string;
  posterUserId: string;
  fullName: string;
  email: string | null;
  onboardedAt: string;
  openDraftCount: number;
}

export interface ProviderOsDraftSummary {
  id: string;
  posterUserId: string;
  posterName: string;
  title: string;
  category: string;
  status: string;
  scopeSummary: string;
  zip: string | null;
  region: string | null;
  estPriceMinCents: number | null;
  estPriceMaxCents: number | null;
  createdAt: string;
}

export interface ProviderOsDraftDetail extends ProviderOsDraftSummary {
  taskFacts: ReturnType<typeof getTaskFactsForDisplay>;
  rawInput: string;
  quoteId: string | null;
  existingQuote: { id: string; status: string; acquisition_origin: string | null } | null;
  assessmentRequestId: string | null;
  assessmentStatus: string | null;
  assessmentCustomerMessage: string | null;
  assessmentWindowStart: string | null;
  assessmentWindowEnd: string | null;
  assessmentScheduledDate: string | null;
  assessmentFeeCents: number | null;
  assessmentQuoteId: string | null;
  preferredWindow: string;
  preferredArrivalWindowStart: string;
  preferredArrivalWindowEnd: string;
  quoteAction: {
    kind: 'EXISTING_QUOTE_FLOW';
    href: string;
  };
}

export interface ProviderOsInviteCreated {
  inviteId: string;
  token: string;
  invitePath: string;
  intendedEmail: string | null;
  expiresAt: string;
}

export interface ProviderOsInvitePreview {
  inviteId: string;
  providerName: string;
  intendedEmail: string | null;
  expiresAt: string;
}

function preferredWindowFromStructured(structured: unknown): string {
  const answers =
    structured &&
    typeof structured === 'object' &&
    !Array.isArray(structured) &&
    'answers' in structured &&
    structured.answers &&
    typeof structured.answers === 'object' &&
    !Array.isArray(structured.answers)
      ? structured.answers as Record<string, unknown>
      : {};

  return String(answers.preferred_window ?? 'flexible');
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

function newInviteToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createProviderOsInvite(input: {
  actorId: string; organizationId: string; intendedEmail?: string | null;
}): Promise<ServiceResult<ProviderOsInviteCreated>> {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'MANAGE_MEMBERS' }, query);
    const token = newInviteToken();
    const intendedEmail = input.intendedEmail ? normalizePosterEmail(input.intendedEmail) : null;
    const expiresAt = new Date(Date.now() + PROVIDER_OS_INVITE_TTL_DAYS * 86400000);
    const inserted = await query<{ id: string }>(
      `INSERT INTO provider_os_invites
       (provider_organization_id, created_by_user_id, token_hash, intended_email, status, expires_at)
       VALUES ($1, $2, $3, $4, 'open', $5) RETURNING id`,
      [input.organizationId, input.actorId, hashInviteToken(token), intendedEmail, expiresAt],
    );
    return { success: true, data: { inviteId: inserted.rows[0].id, token,
      invitePath: `/provider-os/invite/${token}`, intendedEmail, expiresAt: expiresAt.toISOString() } };
  });
}

/** One validity path for public preview and customer acceptance. Org comes only from token. */
async function validatedInvite(rawToken: string, query: QueryFn) {
  if (!isProviderOsInviteToken(rawToken)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite unavailable.' });
  const result = await query<{
    id: string; provider_organization_id: string; created_by_user_id: string | null;
    intended_email: string | null; expires_at: Date; provider_name: string;
  }>(`SELECT i.id, i.provider_organization_id, i.created_by_user_id, i.intended_email,
            i.expires_at, o.display_name AS provider_name
       FROM provider_os_invites i
       JOIN business_organizations o ON o.id = i.provider_organization_id
      WHERE i.token_hash = $1 AND i.status = 'open' AND i.expires_at > NOW()
      FOR UPDATE OF i`, [hashInviteToken(rawToken)]);
  const invite = result.rows[0];
  if (!invite) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite unavailable.' });
  const access = await providerOsOrganizationState(invite.provider_organization_id, query);
  if (access.state !== 'active') throw new TRPCError({ code: 'FORBIDDEN', message: 'This business invitation is no longer available.' });
  return invite;
}

export async function previewProviderOsInvite(token: string): Promise<ServiceResult<ProviderOsInvitePreview>> {
  return db.transaction(async (query) => {
    const invite = await validatedInvite(token, query);
    return { success: true, data: { inviteId: invite.id, providerName: invite.provider_name,
      intendedEmail: invite.intended_email, expiresAt: invite.expires_at.toISOString() } };
  });
}

export async function acceptProviderOsInvite(input: {
  actorId: string; actorEmail: string | null | undefined; token: string;
}): Promise<ServiceResult<ProviderOsClient>> {
  return db.transaction(async (query) => {
    const invite = await validatedInvite(input.token, query);
    const poster = await query<{ id: string; full_name: string; email: string | null }>(
      `SELECT id, full_name, email FROM users WHERE id = $1 AND account_status = 'ACTIVE'
       AND NOT COALESCE(is_banned, false) FOR SHARE`, [input.actorId]);
    const user = poster.rows[0];
    if (!user) return failure('FORBIDDEN', 'Active customer account required.');
    if (
      invite.intended_email
      && (!user.email || normalizePosterEmail(user.email) !== invite.intended_email)
    ) {
      return failure('FORBIDDEN', 'Sign in with the email this invite was created for.');
    }
    if (invite.created_by_user_id === input.actorId) return failure('FORBIDDEN', 'You cannot accept your own invitation.');
    // ON CONFLICT waits for concurrent acceptance. A revoked pair is never reactivated.
    const linked = await query<{ id: string; onboarded_at: Date }>(
      `INSERT INTO provider_os_relationships
       (provider_organization_id, poster_user_id, created_by_user_id, accepted_by_user_id, accepted_at, status)
       VALUES ($1, $2, $3, $2, NOW(), 'active')
       ON CONFLICT (provider_organization_id, poster_user_id) DO NOTHING
       RETURNING id, onboarded_at`,
      [invite.provider_organization_id, input.actorId, invite.created_by_user_id]);
    const existing = linked.rows[0] ? null : await query<{ id: string; onboarded_at: Date; status: string }>(
      `SELECT id, onboarded_at, status FROM provider_os_relationships
       WHERE provider_organization_id = $1 AND poster_user_id = $2 FOR UPDATE`,
      [invite.provider_organization_id, input.actorId]);
    if (existing?.rows[0]?.status !== undefined && existing.rows[0].status !== 'active') {
      return failure('FORBIDDEN', 'This business relationship was revoked. Contact support.');
    }
    const relationship = linked.rows[0] ?? existing?.rows[0];
    if (!relationship) throw new Error('Provider OS relationship creation failed');
    if (linked.rows[0]) {
      await query(`UPDATE provider_os_invites SET accepted_count = accepted_count + 1,
        last_accepted_by_user_id = $2, last_accepted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [invite.id, input.actorId]);
      await query(`INSERT INTO business_audit_events
        (organization_id, actor_id, action, object_type, object_id, after_state)
        VALUES ($1, $2, 'PROVIDER_OS_CLIENT_ACCEPTED', 'PROVIDER_OS_RELATIONSHIP', $3, $4::jsonb)`,
        [invite.provider_organization_id, input.actorId, relationship.id, JSON.stringify({ inviteId: invite.id })]);
    }
    return { success: true, data: { relationshipId: relationship.id, posterUserId: user.id,
      fullName: user.full_name, email: user.email, onboardedAt: relationship.onboarded_at.toISOString(), openDraftCount: 0 } };
  });
}

export async function listProviderOsClients(input: { actorId: string; organizationId: string }): Promise<ServiceResult<ProviderOsClient[]>> {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);

    const result = await query<{
      id: string;
      poster_user_id: string;
      full_name: string;
      email: string | null;
      onboarded_at: Date;
      open_draft_count: string;
    }>(
      `SELECT r.id,
              r.poster_user_id,
              u.full_name,
              u.email,
              r.onboarded_at,
              COUNT(d.id) FILTER (
                WHERE d.claimed_at IS NULL
                  AND d.task_id IS NULL
                  AND d.quote_id IS NULL
                  AND d.status = ANY($2::text[])
                  AND NOT EXISTS (
                    SELECT 1
                    FROM quotes q
                    WHERE q.task_draft_id = d.id
                      AND q.business_organization_id = r.provider_organization_id
                      AND q.status NOT IN ('rejected', 'withdrawn', 'expired', 'superseded')
                  )
              )::text AS open_draft_count
         FROM provider_os_relationships r
         JOIN users u ON u.id = r.poster_user_id AND u.account_status = 'ACTIVE'
         LEFT JOIN task_drafts d ON d.poster_user_id = r.poster_user_id
        WHERE r.provider_organization_id = $1
          AND r.status = 'active'
        GROUP BY r.id, r.poster_user_id, u.full_name, u.email, r.onboarded_at
        ORDER BY r.onboarded_at DESC`,
      [input.organizationId, [...PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES]],
    );

    return {
      success: true,
      data: result.rows.map((row) => ({
        relationshipId: row.id,
        posterUserId: row.poster_user_id,
        fullName: row.full_name,
        email: row.email,
        onboardedAt: row.onboarded_at.toISOString(),
        openDraftCount: Number(row.open_draft_count),
      })),
    };
  });
}

export async function listProviderOsDrafts(input: {
  actorId: string;
  organizationId: string;
  posterUserId?: string;
}): Promise<ServiceResult<ProviderOsDraftSummary[]>> {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);

    const result = await query<{
      id: string;
      poster_user_id: string;
      poster_name: string;
      title: string | null;
      category: string;
      status: string;
      scope_summary: string | null;
      zip: string | null;
      region: string | null;
      est_price_min_cents: number | null;
      est_price_max_cents: number | null;
      created_at: Date;
      claimed_at: Date | null;
      task_id: string | null;
      quote_id: string | null;
    }>(
      `SELECT d.id,
              d.poster_user_id,
              u.full_name AS poster_name,
              d.title,
              d.category,
              d.status,
              d.scope_summary,
              d.zip,
              d.region,
              d.est_price_min_cents,
              d.est_price_max_cents,
              d.created_at,
              d.claimed_at,
              d.task_id,
              d.quote_id
         FROM task_drafts d
         JOIN provider_os_relationships r
           ON r.poster_user_id = d.poster_user_id
          AND r.provider_organization_id = $1
          AND r.status = 'active'
         JOIN users u ON u.id = d.poster_user_id AND u.account_status = 'ACTIVE'
        WHERE d.poster_user_id IS NOT NULL
          AND ($2::uuid IS NULL OR d.poster_user_id = $2)
          AND d.claimed_at IS NULL AND d.task_id IS NULL AND d.quote_id IS NULL
          AND d.status = ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM quotes q
            WHERE q.task_draft_id = d.id
              AND q.business_organization_id = $1
              AND q.status NOT IN ('rejected', 'withdrawn', 'expired', 'superseded')
          )
        ORDER BY d.created_at DESC
        LIMIT 100`,
      [input.organizationId, input.posterUserId ?? null, [...PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES]],
    );

    return {
      success: true,
      data: result.rows
        .map((row) => ({
          id: row.id,
          posterUserId: row.poster_user_id,
          posterName: row.poster_name,
          title: row.title ?? 'Untitled request',
          category: row.category,
          status: row.status,
          scopeSummary: row.scope_summary ?? '',
          zip: row.zip,
          region: row.region,
          estPriceMinCents: row.est_price_min_cents,
          estPriceMaxCents: row.est_price_max_cents,
          createdAt: row.created_at.toISOString(),
        })),
    };
  });
}

export async function getProviderOsDraft(input: {
  actorId: string;
  organizationId: string;
  draftId: string;
}): Promise<ServiceResult<ProviderOsDraftDetail>> {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);

    const result = await query<{
      id: string;
      poster_user_id: string;
      poster_name: string;
      title: string | null;
      category: string;
      status: string;
      scope_summary: string | null;
      raw_input: string;
      zip: string | null;
      region: string | null;
      est_price_min_cents: number | null;
      est_price_max_cents: number | null;
      created_at: Date;
      claimed_at: Date | null;
      task_id: string | null;
      quote_id: string | null;
      structured: unknown;
      relationship_id: string;
    }>(
      `SELECT d.id,
              d.poster_user_id,
              u.full_name AS poster_name,
              d.title,
              d.category,
              d.status,
              d.scope_summary,
              d.raw_input,
              d.zip,
              d.region,
              d.est_price_min_cents,
              d.est_price_max_cents,
              d.created_at,
              d.claimed_at,
              d.task_id,
              d.quote_id,
              d.structured,
              r.id AS relationship_id
         FROM task_drafts d
         JOIN provider_os_relationships r
           ON r.poster_user_id = d.poster_user_id
          AND r.provider_organization_id = $1
          AND r.status = 'active'
         JOIN users u ON u.id = d.poster_user_id AND u.account_status = 'ACTIVE'
        WHERE d.id = $2`,
      [input.organizationId, input.draftId],
    );

    const row = result.rows[0];
    if (!row) return failure('NOT_FOUND', 'That request is not visible in Provider OS.');
    if (!isProviderOsEligibleDraft({
      status: row.status,
      claimedAt: row.claimed_at,
      taskId: row.task_id,
      posterUserId: row.poster_user_id,
      quoteId: row.quote_id,
    })) {
      return failure('INVALID_STATE', 'This request is no longer an unclaimed Provider OS draft.');
    }

    const alreadyQuoted = await query<{ id: string; status: string; acquisition_origin: string | null }>(
      `
      SELECT id, status, acquisition_origin
      FROM quotes
      WHERE task_draft_id = $1
        AND business_organization_id = $2
        AND status NOT IN ('rejected', 'withdrawn', 'expired', 'superseded')
      LIMIT 1
      `,
      [row.id, input.organizationId],
    );
    const assessment = await query<{
      id: string; status: string; customer_message: string | null;
      proposed_window_start: Date; proposed_window_end: Date;
      scheduled_date: string | null; assessment_fee_cents: number | null;
      quote_id: string | null;
    }>(
      `SELECT id,status,customer_message,proposed_window_start,proposed_window_end,
              scheduled_date::text AS scheduled_date,assessment_fee_cents,quote_id
       FROM business_assessment_requests
       WHERE provider_os_relationship_id=$1 AND task_draft_id=$2
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [row.relationship_id,row.id],
    );
    const assessmentRow = assessment.rows[0];
    const preferredWindow = preferredWindowFromStructured(row.structured);
    const customerWindow = computePreferredArrivalWindow(preferredWindow);

    return {
      success: true,
      data: {
        id: row.id,
        posterUserId: row.poster_user_id,
        posterName: row.poster_name,
        title: row.title ?? 'Untitled request',
        category: row.category,
        status: row.status,
        scopeSummary: row.scope_summary ?? '',
        rawInput: row.raw_input,
        taskFacts: getTaskFactsForDisplay({ rawInput: row.raw_input, category: row.category, structured: row.structured }),
        zip: row.zip,
        region: row.region,
        estPriceMinCents: row.est_price_min_cents,
        estPriceMaxCents: row.est_price_max_cents,
        createdAt: row.created_at.toISOString(),
        quoteId: row.quote_id,
        existingQuote: alreadyQuoted.rows[0] ?? null,
        assessmentRequestId: assessmentRow?.id ?? null,
        assessmentStatus: assessmentRow?.status ?? null,
        assessmentCustomerMessage: assessmentRow?.customer_message ?? null,
        assessmentWindowStart: assessmentRow?.proposed_window_start?.toISOString() ?? null,
        assessmentWindowEnd: assessmentRow?.proposed_window_end?.toISOString() ?? null,
        assessmentScheduledDate: assessmentRow?.scheduled_date ?? null,
        assessmentFeeCents: assessmentRow?.assessment_fee_cents ?? null,
        assessmentQuoteId: assessmentRow?.quote_id ?? null,
        preferredWindow,
        preferredArrivalWindowStart: customerWindow.arrivalStart.toISOString(),
        preferredArrivalWindowEnd: customerWindow.arrivalEnd.toISOString(),
        quoteAction: {
          kind: 'EXISTING_QUOTE_FLOW',
          href: `/provider-os/drafts/${row.id}/quote?organizationId=${input.organizationId}`,
        },
      },
    };
  });
}

export interface ProviderOsSetQuoteResult {
  taskDraftId: string;
  quoteId: string;
  quoteVersionId: string;
  customerTotalCents: number;
  payoutCents: number;
  platformMarginCents: number;
  expiresAt: string;
}

/**
 * Provider OS entry into the shared business quote path.
 * Auth = active onboarded-client relationship (not an Ops claim link).
 */
export async function setProviderOsDraftQuote(input: {
  actorId: string;
  draftId: string;
  organizationId: string;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
  arrivalWindowStart: string;
  arrivalWindowEnd: string;
}): Promise<ServiceResult<ProviderOsSetQuoteResult>> {
  await assertProviderOsAccess({ ...input, operation: 'ASSIGN_CREW' });

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

  try {
    const quoted = await db.transaction(async (query) => {
      // Match canonical claim quoting: organization eligibility before draft lock.
      await assertProviderOsAccess({ ...input, operation: 'ASSIGN_CREW' }, query);
      const businessReady = await validateBusinessQuoteContext(query, {
        organizationId: input.organizationId, actorId: input.actorId,
      });
      if (!businessReady.success) return businessReady;
      const draftResult = await query<{
        id: string;
        poster_user_id: string | null;
        category: string;
        title: string | null;
        scope_summary: string | null;
        status: string;
        quote_id: string | null;
        claimed_at: Date | null;
        task_id: string | null;
      }>(
        `
        SELECT id, poster_user_id, category, title, scope_summary,
               status, quote_id, claimed_at, task_id
        FROM task_drafts
        WHERE id = $1
        FOR UPDATE
        `,
        [input.draftId],
      );

      const draft = draftResult.rows[0];
      if (!draft) {
        return failure('NOT_FOUND', 'That request is not visible in Provider OS.');
      }

      if (!isProviderOsEligibleDraft({
        status: draft.status,
        claimedAt: draft.claimed_at,
        taskId: draft.task_id,
        posterUserId: draft.poster_user_id,
        quoteId: draft.quote_id,
      })) {
        return failure(
          'INVALID_STATE',
          'This request is no longer eligible to quote through Provider OS.',
        );
      }

      const relationship = await query<{ id: string }>(
        `
        SELECT r.id
          FROM provider_os_relationships r
          JOIN users u ON u.id = r.poster_user_id AND u.account_status = 'ACTIVE'
         WHERE r.provider_organization_id = $1
           AND r.poster_user_id = $2
           AND r.status = 'active'
         FOR SHARE OF r, u
        `,
        [input.organizationId, draft.poster_user_id],
      );

      if (!relationship.rows[0]) {
        return failure(
          'FORBIDDEN',
          'You can only quote tasks from active clients of this business in Provider OS.',
        );
      }

      const activeAssessment = await query<{ id: string }>(
        `SELECT id FROM business_assessment_requests
         WHERE provider_os_relationship_id=$1 AND task_draft_id=$2
           AND status NOT IN ('ADMIN_REJECTED','CUSTOMER_DECLINED','CANCELLED') LIMIT 1`,
        [relationship.rows[0].id,draft.id],
      );
      if (activeAssessment.rows[0]) {
        return failure('ASSESSMENT_ACTIVE', 'Complete the onsite assessment before submitting its final quote.');
      }

      if (!draft.poster_user_id) {
        return failure('INVALID_STATE', 'This request is no longer eligible to quote through Provider OS.');
      }

      const quoteExpiresAt = new Date(
        Date.now() + PROVIDER_OS_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      );

      const quoteWrite = await createBusinessQuoteInTransaction(query, {
        acquisitionOrigin: 'provider_os',
        draft: {
          id: draft.id,
          title: draft.title,
          scope_summary: draft.scope_summary,
          poster_user_id: draft.poster_user_id,
        },
        organizationId: input.organizationId,
        actorId: input.actorId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
        quoteExpiresAt,
      });
      if (!quoteWrite.success) {
        return failure(quoteWrite.error.code, quoteWrite.error.message);
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
            quoteId: quoteWrite.data.quoteId,
            quoteVersionId: quoteWrite.data.quoteVersionId,
            customerTotalCents: input.proposedCustomerTotalCents,
            payoutCents: input.proposedPayoutCents,
            entry: 'provider_os',
          }),
        ],
      );

      return {
        success: true as const,
        data: {
          taskDraftId: draft.id,
          quoteId: quoteWrite.data.quoteId,
          quoteVersionId: quoteWrite.data.quoteVersionId,
          customerTotalCents: quoteWrite.data.customerTotalCents,
          payoutCents: quoteWrite.data.payoutCents,
          platformMarginCents: quoteWrite.data.platformMarginCents,
          expiresAt: quoteExpiresAt.toISOString(),
        },
      };
    });

    if (!quoted.success) return quoted;

    return {
      success: true,
      data: {
        taskDraftId: quoted.data.taskDraftId,
        quoteId: quoted.data.quoteId,
        quoteVersionId: quoted.data.quoteVersionId,
        customerTotalCents: quoted.data.customerTotalCents,
        payoutCents: quoted.data.payoutCents,
        platformMarginCents: quoted.data.platformMarginCents,
        expiresAt: quoted.data.expiresAt,
      },
    };
  } catch {
    return failure('PROVIDER_OS_QUOTE_FAILED', 'Unable to set a quote for this Provider OS task.');
  }
}
