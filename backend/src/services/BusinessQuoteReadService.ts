import { db } from '../db.js';

export const BUSINESS_QUOTE_STATUSES = [
  'draft',
  'pending_business_verification',
  'submitted',
  'quote_ready',
  'quote_send_ready',
  'paid',
  'rejected',
  'superseded',
  'expired',
  'withdrawn',
] as const;

export type BusinessQuoteStatus = (typeof BUSINESS_QUOTE_STATUSES)[number];

export const OPEN_BUSINESS_QUOTE_STATUSES = [
  'pending_business_verification',
  'submitted',
  'quote_send_ready',
  'quote_ready',
] as const satisfies readonly BusinessQuoteStatus[];

export interface BusinessQuoteSummary {
  quoteId: string;
  quoteVersionId: string | null;
  acquisitionOrigin: 'claim_link' | 'direct_proposal' | 'provider_os' | null;
  quoteStatus: BusinessQuoteStatus;
  displayStatus: BusinessQuoteStatus;
  taskDraftId: string;
  taskId: string | null;
  title: string;
  category: string | null;
  customerName: string | null;
  region: string | null;
  zip: string | null;
  customerTotalCents: number | null;
  payoutCents: number | null;
  arrivalWindowStart: string | null;
  arrivalWindowEnd: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  claimLinkId: string | null;
  proposalId: string | null;
}

interface QuoteRow {
  quote_id: string;
  quote_version_id: string | null;
  acquisition_origin: BusinessQuoteSummary['acquisitionOrigin'];
  quote_status: BusinessQuoteStatus;
  display_status: BusinessQuoteStatus;
  task_draft_id: string;
  task_id: string | null;
  title: string;
  category: string | null;
  customer_name: string | null;
  region: string | null;
  zip: string | null;
  customer_total_cents: number | string | null;
  payout_cents: number | string | null;
  arrival_window_start: Date | string | null;
  arrival_window_end: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  claim_link_id: string | null;
  proposal_id: string | null;
}

export interface BusinessQuoteCursor {
  v: 1;
  organizationId: string;
  openOnly: boolean;
  statuses: BusinessQuoteStatus[] | null;
  createdAt: string;
  quoteId: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeBusinessQuoteStatuses(
  statuses: readonly BusinessQuoteStatus[] | undefined
): BusinessQuoteStatus[] | null {
  if (!statuses) return null;
  const requested = new Set(statuses);
  return BUSINESS_QUOTE_STATUSES.filter((status) => requested.has(status));
}

export function decodeBusinessQuoteCursor(
  value: string,
  organizationId: string,
  openOnly: boolean,
  statuses: readonly BusinessQuoteStatus[] | null
): BusinessQuoteCursor {
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as BusinessQuoteCursor;
    const expectedStatuses = statuses ? [...statuses] : null;
    if (
      cursor.v !== 1 ||
      cursor.organizationId !== organizationId ||
      cursor.openOnly !== openOnly ||
      JSON.stringify(cursor.statuses) !== JSON.stringify(expectedStatuses) ||
      typeof cursor.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      typeof cursor.quoteId !== 'string' ||
      !uuid.test(cursor.quoteId) ||
      Buffer.from(JSON.stringify(cursor)).toString('base64url') !== value
    ) {
      throw new Error('Invalid cursor');
    }
    return cursor;
  } catch {
    throw new Error('Invalid business quote cursor.');
  }
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const cents = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

export async function listBusinessQuotes(input: {
  actorId: string;
  organizationId: string;
  openOnly: boolean;
  statuses: readonly BusinessQuoteStatus[] | null;
  limit: number;
  cursor: BusinessQuoteCursor | null;
}): Promise<{ items: BusinessQuoteSummary[]; nextCursor: string | null }> {
  const authority = await db.query<{ id: string }>(
    `SELECT organization.id
       FROM business_organizations organization
      WHERE organization.id = $1
        AND organization.status = 'ACTIVE'
        AND business_membership_has_action(organization.id, $2, 'READ_WORKSPACE')`,
    [input.organizationId, input.actorId]
  );
  if (!authority.rows[0]) throw new Error('BUSINESS_QUOTE_ACCESS_DENIED');

  const result = await db.query<QuoteRow>(
    `WITH quote_page AS (
       SELECT quote.id
         FROM quotes quote
         JOIN task_drafts draft ON draft.id = quote.task_draft_id
         LEFT JOIN quote_versions version
           ON version.id = quote.active_version_id
          AND version.quote_id = quote.id
        WHERE quote.business_organization_id = $1
          AND ($2::text[] IS NULL OR quote.status = ANY($2::text[]))
          AND (
            $3::boolean IS FALSE
            OR (
              quote.status = ANY($4::text[])
              AND NOT (
                quote.status = 'submitted'
                AND (version.id IS NULL OR version.expires_at <= NOW())
              )
              AND NOT (
                quote.status = 'pending_business_verification'
                AND (
                  version.id IS NULL
                  OR version.status <> 'draft'
                  OR version.expires_at IS NULL
                  OR version.expires_at <= NOW()
                  OR version.arrival_window_end IS NULL
                  OR version.arrival_window_end <= NOW()
                  OR version.dispatch_expires_at IS NULL
                  OR version.dispatch_expires_at <= NOW()
                )
              )
              AND NOT (
                quote.status = 'quote_send_ready'
                AND (
                  COALESCE(
                    quote.task_id,
                    CASE WHEN draft.quote_id = quote.id THEN draft.task_id END
                  ) IS NOT NULL
                  OR EXISTS (
                    SELECT 1 FROM quote_payments payment
                     WHERE payment.quote_id = quote.id
                       AND payment.status IN ('SUCCEEDED', 'REFUNDED')
                  )
                )
              )
            )
          )
          AND (
            $5::timestamptz IS NULL
            OR (quote.created_at, quote.id) < ($5::timestamptz, $6::uuid)
          )
        ORDER BY quote.created_at DESC, quote.id DESC
        LIMIT $7
     )
     SELECT
       quote.id AS quote_id,
       quote.active_version_id AS quote_version_id,
       quote.acquisition_origin,
       quote.status AS quote_status,
       CASE
         WHEN quote.status = 'submitted'
          AND (version.id IS NULL OR version.expires_at <= NOW())
           THEN 'expired'
         WHEN quote.status = 'pending_business_verification'
          AND (
            version.id IS NULL
            OR version.status <> 'draft'
            OR version.expires_at IS NULL
            OR version.expires_at <= NOW()
            OR version.arrival_window_end IS NULL
            OR version.arrival_window_end <= NOW()
            OR version.dispatch_expires_at IS NULL
            OR version.dispatch_expires_at <= NOW()
          )
           THEN 'expired'
         ELSE quote.status
       END AS display_status,
       draft.id AS task_draft_id,
       COALESCE(
         quote.task_id,
         CASE WHEN draft.quote_id = quote.id THEN draft.task_id END
       ) AS task_id,
       COALESCE(NULLIF(BTRIM(draft.title), ''), NULLIF(BTRIM(quote.title), ''), 'Service request') AS title,
       draft.category,
       NULLIF(BTRIM(poster.full_name), '') AS customer_name,
       draft.region,
       draft.zip,
       version.total_cents AS customer_total_cents,
       version.hustler_payout_cents AS payout_cents,
       version.arrival_window_start,
       version.arrival_window_end,
       version.expires_at,
       quote.created_at,
       quote.updated_at,
       CASE
         WHEN quote.acquisition_origin = 'claim_link' THEN claim.id
         WHEN quote.acquisition_origin IS NULL AND proposal.id IS NULL THEN claim.id
         ELSE NULL
       END AS claim_link_id,
       CASE
         WHEN quote.acquisition_origin = 'direct_proposal' THEN proposal.id
         WHEN quote.acquisition_origin IS NULL THEN proposal.id
         ELSE NULL
       END AS proposal_id
      FROM quote_page page
      JOIN quotes quote ON quote.id = page.id
      JOIN task_drafts draft ON draft.id = quote.task_draft_id
      LEFT JOIN quote_versions version
        ON version.id = quote.active_version_id
       AND version.quote_id = quote.id
      LEFT JOIN users poster ON poster.id = draft.poster_user_id
      LEFT JOIN LATERAL (
        SELECT candidate.id
          FROM business_task_proposals candidate
         WHERE candidate.quote_id = quote.id
           AND candidate.business_organization_id = quote.business_organization_id
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
      ) proposal ON TRUE
      LEFT JOIN LATERAL (
        SELECT candidate.id
          FROM ops_business_claim_links candidate
         WHERE candidate.quote_id = quote.id
           AND (
             candidate.claimed_by_organization_id = quote.business_organization_id
             OR (
               candidate.claimed_by_organization_id IS NULL
               AND candidate.invited_organization_id = quote.business_organization_id
             )
           )
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
      ) claim ON TRUE
     ORDER BY quote.created_at DESC, quote.id DESC`,
    [
      input.organizationId,
      input.statuses,
      input.openOnly,
      OPEN_BUSINESS_QUOTE_STATUSES,
      input.cursor?.createdAt ?? null,
      input.cursor?.quoteId ?? null,
      input.limit + 1,
    ]
  );

  const page = result.rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      quoteId: row.quote_id,
      quoteVersionId: row.quote_version_id,
      acquisitionOrigin: row.acquisition_origin,
      quoteStatus: row.quote_status,
      displayStatus: row.display_status,
      taskDraftId: row.task_draft_id,
      taskId: row.task_id,
      title: row.title,
      category: row.category,
      customerName: row.customer_name,
      region: row.region,
      zip: row.zip,
      customerTotalCents: cents(row.customer_total_cents),
      payoutCents: cents(row.payout_cents),
      arrivalWindowStart: iso(row.arrival_window_start),
      arrivalWindowEnd: iso(row.arrival_window_end),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      claimLinkId: row.claim_link_id,
      proposalId: row.proposal_id,
    })),
    nextCursor:
      result.rows.length > input.limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              organizationId: input.organizationId,
              openOnly: input.openOnly,
              statuses: input.statuses ? [...input.statuses] : null,
              createdAt: iso(last.created_at)!,
              quoteId: last.quote_id,
            } satisfies BusinessQuoteCursor)
          ).toString('base64url')
        : null,
  };
}
