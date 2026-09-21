import crypto from 'node:crypto';
import { TRPCError } from '@trpc/server';

import { config } from '../config.js';
import { db, type QueryFn } from '../db.js';
import { hashNormalizedPhone, maskPhone, normalizePhoneToE164 } from '../lib/phone.js';
import { NotificationService } from './NotificationService.js';

const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function pendingPhoneClaimToken(claimId: string): string {
  const signature = crypto
    .createHmac('sha256', config.queue.hmacSecret)
    .update(`pending-phone-claim:${claimId}`, 'utf8')
    .digest('base64url');
  return `${claimId}.${signature}`;
}

function publicWebOrigin(): string {
  return (process.env.HX_PUBLIC_WEB_URL
    || config.app.allowedOrigins[0]
    || 'http://localhost:5173').replace(/\/$/, '');
}

export function pendingPhoneClaimSmsBody(claimId: string): string {
  const token = pendingPhoneClaimToken(claimId);
  return `HustleXP created your service request. Continue securely: ${publicWebOrigin()}/customer/claim/${encodeURIComponent(token)}`;
}

export interface PendingPhoneClaimCreated {
  claimId: string;
  rawToken: string;
  expiresAt: Date;
  smsQueued: boolean;
}

export type PendingPhoneClaimDiagnosticEvent = {
  stage:
    | 'pending_claim_create_start'
    | 'pending_claim_create_success'
    | 'sms_enqueue_start'
    | 'sms_enqueue_success';
  claimId?: string;
  smsId?: string;
};

export async function createPendingPhoneClaimInTransaction(
  query: QueryFn,
  input: {
    taskDraftId: string;
    normalizedPhone: string;
    createdByOpsUserId: string;
    auditMetadata?: Record<string, unknown>;
    onDiagnosticStage?: (event: PendingPhoneClaimDiagnosticEvent) => void;
  },
): Promise<PendingPhoneClaimCreated> {
  const claimId = crypto.randomUUID();
  const rawToken = pendingPhoneClaimToken(claimId);
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
  input.onDiagnosticStage?.({ stage: 'pending_claim_create_start', claimId });
  const claim = await query<{ id: string }>(
    `INSERT INTO pending_phone_draft_claims
       (id, task_draft_id, intended_phone_e164, intended_phone_hash, token_hash,
        expires_at, created_by_ops_user_id, audit_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING id`,
    [
      claimId,
      input.taskDraftId,
      input.normalizedPhone,
      hashNormalizedPhone(input.normalizedPhone),
      tokenHash(rawToken),
      expiresAt,
      input.createdByOpsUserId,
      JSON.stringify(input.auditMetadata ?? {}),
    ],
  );
  const persistedClaimId = claim.rows[0]?.id;
  if (!persistedClaimId) throw new Error('PENDING_PHONE_CLAIM_NOT_CREATED');
  input.onDiagnosticStage?.({
    stage: 'pending_claim_create_success',
    claimId: persistedClaimId,
  });

  // The raw capability is never persisted. The worker deterministically rebuilds
  // it from the random claim id plus the server-only queue HMAC secret.
  const body = 'pending_phone_claim';
  const idempotencyKey = `pending-phone-claim:${claimId}:sms:v1`;
  input.onDiagnosticStage?.({ stage: 'sms_enqueue_start', claimId: persistedClaimId });
  const sms = await query<{ id: string }>(
    `INSERT INTO sms_outbox
       (user_id, to_phone, body, status, idempotency_key, recipient_kind, recipient_context_id)
     VALUES (NULL,$1,$2,'pending',$3,'pending_phone_claim',$4)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       available_at = LEAST(sms_outbox.available_at, EXCLUDED.available_at),
       updated_at = NOW()
     RETURNING id`,
    [input.normalizedPhone, body, idempotencyKey, claimId],
  );
  const smsId = sms.rows[0]?.id;
  if (!smsId) throw new Error('PENDING_PHONE_CLAIM_SMS_NOT_CREATED');

  await query(
    `INSERT INTO outbox_events
       (event_type, aggregate_type, aggregate_id, event_version, idempotency_key,
        payload, queue_name, status, available_at)
     VALUES ('sms.send_requested','pending_phone_draft_claim',$1,1,$2,$3::jsonb,'user_notifications','pending',NOW())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      claimId,
      idempotencyKey,
      JSON.stringify({
        smsId,
        toPhone: input.normalizedPhone,
        body,
      }),
    ],
  );
  input.onDiagnosticStage?.({
    stage: 'sms_enqueue_success',
    claimId: persistedClaimId,
    smsId,
  });

  return { claimId: persistedClaimId, rawToken, expiresAt, smsQueued: true };
}

interface ClaimRow {
  id: string;
  task_draft_id: string;
  intended_phone_e164: string;
  status: 'OPEN' | 'CLAIMED' | 'EXPIRED' | 'REVOKED';
  expires_at: Date;
  claimed_by_user_id: string | null;
}

export async function previewPendingPhoneClaim(rawToken: string): Promise<{
  state: 'open' | 'claimed' | 'expired' | 'revoked' | 'invalid';
  maskedPhone?: string;
}> {
  const row = (await db.query<ClaimRow>(
    `SELECT id, task_draft_id, intended_phone_e164, status, expires_at, claimed_by_user_id
       FROM pending_phone_draft_claims WHERE token_hash = $1 LIMIT 1`,
    [tokenHash(rawToken)],
  )).rows[0];
  if (!row) return { state: 'invalid' };
  if (row.status === 'REVOKED') return { state: 'revoked' };
  if (row.status === 'CLAIMED') return { state: 'claimed', maskedPhone: maskPhone(row.intended_phone_e164) };
  if (row.status === 'EXPIRED' || row.expires_at.getTime() <= Date.now()) {
    return { state: 'expired', maskedPhone: maskPhone(row.intended_phone_e164) };
  }
  return { state: 'open', maskedPhone: maskPhone(row.intended_phone_e164) };
}

export async function claimPendingPhoneDraft(input: {
  rawToken: string;
  userId: string;
  verifiedPhone: string;
}): Promise<{ taskDraftId: string; replayed: boolean }> {
  const result = await db.transaction(async (query) => {
    const claim = (await query<ClaimRow>(
      `SELECT id, task_draft_id, intended_phone_e164, status, expires_at, claimed_by_user_id
         FROM pending_phone_draft_claims WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash(input.rawToken)],
    )).rows[0];
    if (!claim) throw new TRPCError({ code: 'NOT_FOUND', message: 'This continuation link is invalid.' });

    if (claim.status === 'CLAIMED') {
      if (claim.claimed_by_user_id !== input.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This request has already been claimed.' });
      }
      return { taskDraftId: claim.task_draft_id, replayed: true };
    }
    if (claim.status === 'REVOKED') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This continuation link was revoked.' });
    }
    if (claim.status === 'EXPIRED' || claim.expires_at.getTime() <= Date.now()) {
      await query(
        `UPDATE pending_phone_draft_claims SET status='EXPIRED', updated_at=NOW()
          WHERE id=$1 AND status='OPEN'`,
        [claim.id],
      );
      return { expired: true as const };
    }

    const user = (await query<{ id: string; phone: string | null }>(
      `SELECT id, phone FROM users WHERE id=$1 AND account_status='ACTIVE' FOR UPDATE`,
      [input.userId],
    )).rows[0];
    if (!user) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Sign in with the phone number this request was sent to.',
      });
    }
    const verifiedPhone = normalizePhoneToE164(input.verifiedPhone);
    if (verifiedPhone !== claim.intended_phone_e164) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'The verified phone number does not match this request.',
      });
    }
    const collision = await query<{ id: string }>(
      'SELECT id FROM users WHERE phone=$1 AND id<>$2 LIMIT 1',
      [verifiedPhone, user.id],
    );
    if (collision.rows.length) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This verified phone number is linked to another account.',
      });
    }
    if (user.phone && normalizePhoneToE164(user.phone) !== verifiedPhone) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This account is already linked to a different phone number.',
      });
    }
    await query('UPDATE users SET phone=$2, updated_at=NOW() WHERE id=$1 AND phone IS NULL', [user.id, verifiedPhone]);

    const draft = (await query<{ poster_user_id: string | null; lead_id: string | null }>(
      'SELECT poster_user_id, lead_id FROM task_drafts WHERE id=$1 FOR UPDATE',
      [claim.task_draft_id],
    )).rows[0];
    if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task request not found.' });
    if (draft.poster_user_id && draft.poster_user_id !== user.id) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This request belongs to another account.' });
    }

    await query(
      `UPDATE task_drafts SET poster_user_id=$2, updated_at=NOW()
        WHERE id=$1 AND (poster_user_id IS NULL OR poster_user_id=$2)`,
      [claim.task_draft_id, user.id],
    );
    if (draft.lead_id) {
      const lead = (await query<{ user_id: string | null }>(
        'SELECT user_id FROM leads WHERE id=$1 FOR UPDATE',
        [draft.lead_id],
      )).rows[0];
      if (!lead) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Customer request not found.' });
      }
      if (lead.user_id && lead.user_id !== user.id) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This request belongs to another account.' });
      }
      await query(
        `UPDATE leads SET user_id=$2, phone=$3, updated_at=NOW()
          WHERE id=$1 AND (user_id IS NULL OR user_id=$2)`,
        [draft.lead_id, user.id, verifiedPhone],
      );
    }
    await query(
      `UPDATE pending_phone_draft_claims
          SET status='CLAIMED', claimed_by_user_id=$2, claimed_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='OPEN'`,
      [claim.id, user.id],
    );

    const quotes = await query<{ id: string }>(
      `SELECT id FROM quotes
        WHERE task_draft_id=$1 AND status IN
          ('submitted','quote_ready','quote_send_ready')`,
      [claim.task_draft_id],
    );
    for (const quote of quotes.rows) {
      await NotificationService.createInTransaction(query, {
        userId: user.id,
        type: 'QUOTE_RECEIVED',
        title: 'Quote available',
        message: 'A business prepared a quote for your request.',
        entityType: 'quote',
        entityId: quote.id,
        actionUrl: `/dashboard/drafts/${claim.task_draft_id}`,
        dedupeKey: `quote-created:${quote.id}`,
      });
    }

    return { taskDraftId: claim.task_draft_id, replayed: false };
  });

  if ('expired' in result) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This continuation link has expired.' });
  }
  return result;
}

