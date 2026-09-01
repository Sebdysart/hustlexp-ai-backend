import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { isProviderOsEligibleDraft, normalizePosterEmail, PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES } from './ProviderOsPolicy.js';

export interface ProviderOsClient {
  relationshipId: string;
  posterUserId: string;
  fullName: string;
  email: string;
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
  rawInput: string;
  quoteId: string | null;
  quoteAction: {
    kind: 'EXISTING_QUOTE_FLOW';
    href: string;
  };
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

async function assertProviderOsAccess(actorId: string): Promise<ServiceResult<true>> {
  const user = await db.query<{ default_mode: string }>(
    `SELECT default_mode FROM users WHERE id = $1`,
    [actorId],
  );
  if (!user.rows[0]) return failure('NOT_FOUND', 'Account not found.');
  if (user.rows[0].default_mode === 'worker') return { success: true, data: true };

  const workspace = await db.query<{ id: string }>(
    `SELECT o.id
       FROM business_memberships m
       JOIN business_organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1
        AND m.status = 'ACTIVE'
        AND o.provider_enabled = TRUE
      LIMIT 1`,
    [actorId],
  );
  if (workspace.rows[0]) return { success: true, data: true };
  return failure('FORBIDDEN', 'Provider OS is available to hustlers and provider-enabled businesses.');
}

export async function onboardProviderOsClient(input: {
  actorId: string;
  posterEmail: string;
}): Promise<ServiceResult<ProviderOsClient>> {
  const access = await assertProviderOsAccess(input.actorId);
  if (!access.success) return access;

  const email = normalizePosterEmail(input.posterEmail);
  if (!email || !email.includes('@')) {
    return failure('INVALID_INPUT', 'Enter a valid client email.');
  }

  const poster = await db.query<{ id: string; full_name: string; email: string }>(
    `SELECT id, full_name, email FROM users WHERE lower(email) = $1`,
    [email],
  );
  const row = poster.rows[0];
  if (!row) return failure('NOT_FOUND', 'No HustleXP account matched that email.');
  if (row.id === input.actorId) {
    return failure('INVALID_INPUT', 'A provider cannot onboard themselves as a Provider OS client.');
  }

  const upsert = await db.query<{
    id: string;
    poster_user_id: string;
    onboarded_at: Date;
  }>(
    `INSERT INTO provider_os_relationships (provider_user_id, poster_user_id, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (provider_user_id, poster_user_id)
     DO UPDATE SET status = 'active', updated_at = now()
     RETURNING id, poster_user_id, onboarded_at`,
    [input.actorId, row.id],
  );
  const rel = upsert.rows[0];
  if (!rel) return failure('SERVER_ERROR', 'Could not save the Provider OS relationship.');

  return {
    success: true,
    data: {
      relationshipId: rel.id,
      posterUserId: row.id,
      fullName: row.full_name,
      email: row.email,
      onboardedAt: rel.onboarded_at.toISOString(),
      openDraftCount: 0,
    },
  };
}

export async function listProviderOsClients(actorId: string): Promise<ServiceResult<ProviderOsClient[]>> {
  const access = await assertProviderOsAccess(actorId);
  if (!access.success) return access;

  const result = await db.query<{
    id: string;
    poster_user_id: string;
    full_name: string;
    email: string;
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
                AND d.status = ANY($2::text[])
            )::text AS open_draft_count
       FROM provider_os_relationships r
       JOIN users u ON u.id = r.poster_user_id
       LEFT JOIN task_drafts d ON d.poster_user_id = r.poster_user_id
      WHERE r.provider_user_id = $1
        AND r.status = 'active'
      GROUP BY r.id, r.poster_user_id, u.full_name, u.email, r.onboarded_at
      ORDER BY r.onboarded_at DESC`,
    [actorId, [...PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES]],
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
}

export async function listProviderOsDrafts(input: {
  actorId: string;
  posterUserId?: string;
}): Promise<ServiceResult<ProviderOsDraftSummary[]>> {
  const access = await assertProviderOsAccess(input.actorId);
  if (!access.success) return access;

  const result = await db.query<{
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
            d.task_id
       FROM task_drafts d
       JOIN provider_os_relationships r
         ON r.poster_user_id = d.poster_user_id
        AND r.provider_user_id = $1
        AND r.status = 'active'
       JOIN users u ON u.id = d.poster_user_id
      WHERE d.poster_user_id IS NOT NULL
        AND ($2::uuid IS NULL OR d.poster_user_id = $2)
      ORDER BY d.created_at DESC
      LIMIT 100`,
    [input.actorId, input.posterUserId ?? null],
  );

  return {
    success: true,
    data: result.rows
      .filter((row) => isProviderOsEligibleDraft({
        status: row.status,
        claimedAt: row.claimed_at,
        taskId: row.task_id,
        posterUserId: row.poster_user_id,
      }))
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
}

export async function getProviderOsDraft(input: {
  actorId: string;
  draftId: string;
}): Promise<ServiceResult<ProviderOsDraftDetail>> {
  const access = await assertProviderOsAccess(input.actorId);
  if (!access.success) return access;

  const result = await db.query<{
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
            d.quote_id
       FROM task_drafts d
       JOIN provider_os_relationships r
         ON r.poster_user_id = d.poster_user_id
        AND r.provider_user_id = $1
        AND r.status = 'active'
       JOIN users u ON u.id = d.poster_user_id
      WHERE d.id = $2`,
    [input.actorId, input.draftId],
  );

  const row = result.rows[0];
  if (!row) return failure('NOT_FOUND', 'That request is not visible in Provider OS.');
  if (!isProviderOsEligibleDraft({
    status: row.status,
    claimedAt: row.claimed_at,
    taskId: row.task_id,
    posterUserId: row.poster_user_id,
  })) {
    return failure('INVALID_STATE', 'This request is no longer an unclaimed Provider OS draft.');
  }

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
      zip: row.zip,
      region: row.region,
      estPriceMinCents: row.est_price_min_cents,
      estPriceMaxCents: row.est_price_max_cents,
      createdAt: row.created_at.toISOString(),
      quoteId: row.quote_id,
      quoteAction: {
        kind: 'EXISTING_QUOTE_FLOW',
        href: `/provider-os/drafts/${row.id}/quote`,
      },
    },
  };
}
