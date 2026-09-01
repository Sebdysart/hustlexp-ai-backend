import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
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

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

function newInviteToken(): string {
  return randomBytes(32).toString('hex');
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

async function upsertProviderOsRelationship(input: {
  providerUserId: string;
  posterUserId: string;
}): Promise<ServiceResult<{
  relationshipId: string;
  posterUserId: string;
  fullName: string;
  email: string;
  onboardedAt: string;
}>> {
  if (input.providerUserId === input.posterUserId) {
    return failure('INVALID_INPUT', 'A provider cannot onboard themselves as a Provider OS client.');
  }

  const poster = await db.query<{ id: string; full_name: string; email: string }>(
    `SELECT id, full_name, email FROM users WHERE id = $1`,
    [input.posterUserId],
  );
  const row = poster.rows[0];
  if (!row) return failure('NOT_FOUND', 'Client account not found.');

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
    [input.providerUserId, row.id],
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
    },
  };
}

/** @deprecated Prefer createProviderOsInvite + acceptProviderOsInvite for new/existing customers. */
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

  const poster = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = $1`,
    [email],
  );
  const row = poster.rows[0];
  if (!row) {
    return failure(
      'NOT_FOUND',
      'No HustleXP account matched that email. Create an invite link instead so new customers can join.',
    );
  }

  const linked = await upsertProviderOsRelationship({
    providerUserId: input.actorId,
    posterUserId: row.id,
  });
  if (!linked.success) return linked;

  return {
    success: true,
    data: {
      ...linked.data,
      openDraftCount: 0,
    },
  };
}

export async function createProviderOsInvite(input: {
  actorId: string;
  intendedEmail?: string | null;
}): Promise<ServiceResult<ProviderOsInviteCreated>> {
  const access = await assertProviderOsAccess(input.actorId);
  if (!access.success) return access;

  let intendedEmail: string | null = null;
  if (input.intendedEmail && input.intendedEmail.trim()) {
    intendedEmail = normalizePosterEmail(input.intendedEmail);
    if (!intendedEmail.includes('@')) {
      return failure('INVALID_INPUT', 'Enter a valid client email, or leave it blank.');
    }
  }

  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(
    Date.now() + PROVIDER_OS_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const inserted = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO provider_os_invites (
       provider_user_id, token_hash, intended_email, status, expires_at
     ) VALUES ($1, $2, $3, 'open', $4)
     RETURNING id, expires_at`,
    [input.actorId, tokenHash, intendedEmail, expiresAt.toISOString()],
  );
  const row = inserted.rows[0];
  if (!row) return failure('SERVER_ERROR', 'Could not create the invite link.');

  return {
    success: true,
    data: {
      inviteId: row.id,
      token,
      invitePath: `/provider-os/invite/${token}`,
      intendedEmail,
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

export async function previewProviderOsInvite(
  rawToken: string,
): Promise<ServiceResult<ProviderOsInvitePreview>> {
  const token = rawToken.trim();
  if (!isProviderOsInviteToken(token)) {
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  const tokenHash = hashInviteToken(token);
  const result = await db.query<{
    id: string;
    status: string;
    expires_at: Date;
    intended_email: string | null;
    provider_name: string;
  }>(
    `SELECT i.id,
            i.status,
            i.expires_at,
            i.intended_email,
            u.full_name AS provider_name
       FROM provider_os_invites i
       JOIN users u ON u.id = i.provider_user_id
      WHERE i.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (!row || row.status !== 'open') {
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  if (row.expires_at.getTime() <= Date.now()) {
    await db.query(
      `UPDATE provider_os_invites
          SET status = 'expired', updated_at = now()
        WHERE id = $1 AND status = 'open'`,
      [row.id],
    );
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  return {
    success: true,
    data: {
      inviteId: row.id,
      providerName: row.provider_name,
      intendedEmail: row.intended_email,
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

export async function acceptProviderOsInvite(input: {
  actorId: string;
  actorEmail: string | null | undefined;
  token: string;
}): Promise<ServiceResult<ProviderOsClient>> {
  const token = input.token.trim();
  if (!isProviderOsInviteToken(token)) {
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  const tokenHash = hashInviteToken(token);
  const result = await db.query<{
    id: string;
    provider_user_id: string;
    status: string;
    expires_at: Date;
    intended_email: string | null;
  }>(
    `SELECT id, provider_user_id, status, expires_at, intended_email
       FROM provider_os_invites
      WHERE token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );

  const invite = result.rows[0];
  if (!invite || invite.status !== 'open') {
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  if (invite.expires_at.getTime() <= Date.now()) {
    await db.query(
      `UPDATE provider_os_invites
          SET status = 'expired', updated_at = now()
        WHERE id = $1 AND status = 'open'`,
      [invite.id],
    );
    return failure('NOT_FOUND', 'This invite link is invalid or no longer available.');
  }

  if (invite.intended_email) {
    const actorEmail = normalizePosterEmail(input.actorEmail ?? '');
    if (!actorEmail || actorEmail !== invite.intended_email) {
      return failure(
        'FORBIDDEN',
        'Sign in with the email this invite was created for.',
      );
    }
  }

  const linked = await upsertProviderOsRelationship({
    providerUserId: invite.provider_user_id,
    posterUserId: input.actorId,
  });
  if (!linked.success) return linked;

  await db.query(
    `UPDATE provider_os_invites
        SET accepted_count = accepted_count + 1,
            updated_at = now()
      WHERE id = $1`,
    [invite.id],
  );

  return {
    success: true,
    data: {
      ...linked.data,
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
