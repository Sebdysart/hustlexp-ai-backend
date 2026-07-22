import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type QueryFn } from '../db.js';
import { notifyApplicationReceived } from '../lib/task-lifecycle-notifications.js';
import {
  DIRECT_INVITE_CHANNELS,
  EXTERNAL_SHARE_CHANNELS,
  EXTERNAL_TASK_BRIDGE_POLICY_VERSION,
  directInviteRecipientBlockers,
  directProviderInviteCopy,
  externalCandidateEligibility,
  externalLinkBlockers,
  externalOfferTermsHash,
  externalShareCopy,
  externalSharePath,
  externalShareReadiness,
  hashExternalShareToken,
  newExternalShareToken,
  type ExternalBridgeLinkSnapshot,
  type ExternalBridgeTaskSnapshot,
  type ExternalBridgeUserSnapshot,
} from '../services/ExternalTaskBridgePolicy.js';
import { hustlerProcedure, posterProcedure, publicProcedure, router, Schemas } from '../trpc.js';
import { detectForbiddenPatterns } from '../services/MessagingPolicy.js';

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const sourceSchema = z.enum(EXTERNAL_SHARE_CHANNELS);
const directInviteSourceSchema = z.enum(DIRECT_INVITE_CHANNELS);

type BridgeRow = ExternalBridgeTaskSnapshot & ExternalBridgeLinkSnapshot & {
  link_id: string;
  task_id: string;
  source_channel: string;
  link_kind: 'OPEN_SHARE' | 'DIRECT_INVITE';
  claimed_by_user_id: string | null;
};

const SAFE_TASK_SELECT = `
  t.state, t.poster_id, t.title, t.description, t.category, t.scope_hash,
  t.hustler_payout_cents, t.estimated_duration_minutes, t.rough_location,
  t.deadline, t.requirements, t.risk_level, t.required_tools,
  t.cancellation_policy_version, t.late_cancel_pct, t.cancellation_window_hours,
  t.trust_tier_required`;

function failForBlockers(blockers: string[]): never {
  const code = blockers.includes('task_unavailable') || blockers.includes('share_expired')
    || blockers.includes('share_revoked') || blockers.includes('share_stale')
    ? 'NOT_FOUND'
    : 'PRECONDITION_FAILED';
  throw new TRPCError({ code, message: 'This shared task is unavailable or no longer current.' });
}

async function loadBridge(query: QueryFn, tokenHash: string, lock = false): Promise<BridgeRow> {
  const result = await query<BridgeRow>(
    `SELECT l.id AS link_id, l.task_id, l.scope_hash, l.payout_cents, l.source_channel,
            l.link_kind, l.expires_at, l.revoked_at, c.claimed_by_user_id, ${SAFE_TASK_SELECT}
       FROM task_external_share_links l
       JOIN tasks t ON t.id = l.task_id
       LEFT JOIN task_direct_invite_claims c ON c.share_link_id = l.id
      WHERE l.token_hash = $1
      LIMIT 1${lock ? ' FOR UPDATE OF l, t' : ''}`,
    [tokenHash],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shared task not found.' });
  const blockers = externalLinkBlockers(result.rows[0], result.rows[0]);
  if (blockers.length) failForBlockers(blockers);
  return result.rows[0];
}

function publicCard(row: BridgeRow) {
  return {
    title: row.title,
    summary: row.description,
    category: row.category,
    payoutCents: row.hustler_payout_cents,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    area: row.rough_location,
    deadline: row.deadline,
    requirements: row.requirements,
    risk: row.risk_level,
    requiredTools: row.required_tools ?? [],
    scopeHash: row.scope_hash,
    cancellation: {
      policyVersion: row.cancellation_policy_version,
      lateCancelPercent: row.late_cancel_pct,
      windowHours: row.cancellation_window_hours,
    },
    policyVersion: EXTERNAL_TASK_BRIDGE_POLICY_VERSION,
    entryKind: row.link_kind,
    exactAddressProtected: true as const,
  };
}

function eligibilityMessage(blocker: string): string {
  const copy: Record<string, string> = {
    identity_verification_required: 'Complete identity verification before offering availability.',
    trust_hold: 'This account is currently on a trust hold.',
    trust_tier_insufficient: 'This task requires a higher verified trust level.',
    risk_not_supported: 'This task risk category is not available through external sharing.',
    self_dealing: 'The task poster cannot submit a provider offer.',
    direct_invite_claimed: 'This private provider invitation has already been claimed.',
  };
  return copy[blocker] ?? 'This account is not eligible to offer availability for this task.';
}

async function candidateSnapshot(query: QueryFn, tokenHash: string, userId: string, lock = false) {
  const task = await loadBridge(query, tokenHash, lock);
  const result = await query<ExternalBridgeUserSnapshot>(
    `SELECT id, trust_tier, COALESCE(trust_hold, false) AS trust_hold,
            COALESCE(is_verified, false) AS is_verified,
            identity_verification_status,identity_verification_environment,
            identity_verification_expires_at
       FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Account not found.' });
  return {
    task,
    user: result.rows[0],
    blockers: [
      ...externalCandidateEligibility(task, result.rows[0]),
      ...directInviteRecipientBlockers(task, userId),
    ],
  };
}

export const taskExternalBridgeRouter = router({
  createShareLink: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      sourceChannel: sourceSchema,
      expiresInHours: z.number().int().min(1).max(168).default(72),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = newExternalShareToken();
      const tokenHash = hashExternalShareToken(token);
      const path = externalSharePath(token);
      const created = await db.transaction(async (query) => {
        const result = await query<ExternalBridgeTaskSnapshot>(
          `SELECT ${SAFE_TASK_SELECT} FROM tasks t WHERE t.id = $1 FOR UPDATE`,
          [input.taskId],
        );
        const task = result.rows[0];
        if (!task || task.poster_id !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found.' });
        }
        const blockers = externalShareReadiness(task);
        if (blockers.length) failForBlockers(blockers);
        await query(
          `UPDATE task_external_share_links
              SET revoked_at = NOW()
            WHERE task_id = $1 AND created_by = $2 AND source_channel = $3
              AND link_kind = 'OPEN_SHARE'
              AND revoked_at IS NULL AND expires_at > NOW()`,
          [input.taskId, ctx.user.id, input.sourceChannel],
        );
        const link = await query<{ id: string; expires_at: string }>(
          `INSERT INTO task_external_share_links
             (task_id, created_by, token_hash, source_channel, link_kind, scope_hash, payout_cents, expires_at)
           VALUES ($1, $2, $3, $4, 'OPEN_SHARE', $5, $6, NOW() + ($7 * INTERVAL '1 hour'))
           RETURNING id, expires_at`,
          [input.taskId, ctx.user.id, tokenHash, input.sourceChannel, task.scope_hash, task.hustler_payout_cents, input.expiresInHours],
        );
        await query(
          `INSERT INTO task_external_bridge_events
             (share_link_id, task_id, event_type, actor_id, source_channel, payload_hash)
           VALUES ($1, $2, 'SHARE_CREATED', $3, $4, $5)`,
          [link.rows[0].id, input.taskId, ctx.user.id, input.sourceChannel, tokenHash],
        );
        return { task, link: link.rows[0] };
      });
      return {
        path,
        postCopy: externalShareCopy(created.task, path),
        expiresAt: created.link.expires_at,
        sourceChannel: input.sourceChannel,
      };
    }),

  createDirectInvite: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      sourceChannel: directInviteSourceSchema,
      expiresInHours: z.number().int().min(1).max(168).default(72),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = newExternalShareToken();
      const tokenHash = hashExternalShareToken(token);
      const path = externalSharePath(token);
      const created = await db.transaction(async (query) => {
        const result = await query<ExternalBridgeTaskSnapshot>(
          `SELECT ${SAFE_TASK_SELECT} FROM tasks t WHERE t.id = $1 FOR UPDATE`,
          [input.taskId],
        );
        const task = result.rows[0];
        if (!task || task.poster_id !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found.' });
        }
        const blockers = externalShareReadiness(task);
        if (blockers.length) failForBlockers(blockers);
        await query(
          `UPDATE task_external_share_links
              SET revoked_at = NOW()
            WHERE task_id = $1 AND created_by = $2 AND link_kind = 'DIRECT_INVITE'
              AND revoked_at IS NULL AND expires_at > NOW()`,
          [input.taskId, ctx.user.id],
        );
        const link = await query<{ id: string; expires_at: string }>(
          `INSERT INTO task_external_share_links
             (task_id, created_by, token_hash, source_channel, link_kind, scope_hash, payout_cents, expires_at)
           VALUES ($1, $2, $3, $4, 'DIRECT_INVITE', $5, $6, NOW() + ($7 * INTERVAL '1 hour'))
           RETURNING id, expires_at`,
          [input.taskId, ctx.user.id, tokenHash, input.sourceChannel, task.scope_hash, task.hustler_payout_cents, input.expiresInHours],
        );
        await query(
          `INSERT INTO task_external_bridge_events
             (share_link_id, task_id, event_type, actor_id, source_channel, payload_hash)
           VALUES ($1, $2, 'DIRECT_INVITE_CREATED', $3, $4, $5)`,
          [link.rows[0].id, input.taskId, ctx.user.id, input.sourceChannel, tokenHash],
        );
        return { task, link: link.rows[0] };
      });
      return {
        path,
        inviteCopy: directProviderInviteCopy(created.task, path),
        expiresAt: created.link.expires_at,
        sourceChannel: input.sourceChannel,
      };
    }),

  getShareCard: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .query(async ({ ctx, input }) => {
      const row = await loadBridge(db.query.bind(db), hashExternalShareToken(input.token));
      if (directInviteRecipientBlockers(row, ctx.user?.id ?? null).length) failForBlockers(['share_revoked']);
      return publicCard(row);
    }),

  getCandidateOffer: hustlerProcedure
    .input(z.object({ token: tokenSchema }))
    .query(async ({ ctx, input }) => {
      const snapshot = await candidateSnapshot(db.query.bind(db), hashExternalShareToken(input.token), ctx.user.id);
      return {
        card: publicCard(snapshot.task),
        eligibility: {
          eligible: snapshot.blockers.length === 0,
          blockers: snapshot.blockers,
          message: snapshot.blockers.length ? eligibilityMessage(snapshot.blockers[0]) : null,
        },
      };
    }),

  submitExternalOffer: hustlerProcedure
    .input(z.object({
      token: tokenSchema,
      availableFrom: z.string().datetime(),
      availableUntil: z.string().datetime(),
      message: z.string().trim().min(1).max(500),
      acknowledgedScopeHash: z.string().regex(/^[a-f0-9]{64}$/i),
      acknowledgedPayoutCents: z.number().int().positive(),
    }).superRefine((input, context) => {
      if (new Date(input.availableUntil).getTime() <= new Date(input.availableFrom).getTime()) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['availableUntil'], message: 'Availability end must be after the start.' });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      if (detectForbiddenPatterns(input.message).length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Offer notes cannot include contact details, payment instructions, off-platform requests, harassment, prohibited content, or unapproved scope changes.',
        });
      }
      const submitted = await db.transaction(async (query) => {
      const snapshot = await candidateSnapshot(query, hashExternalShareToken(input.token), ctx.user.id, true);
      if (snapshot.blockers.length) {
        throw new TRPCError({ code: 'FORBIDDEN', message: eligibilityMessage(snapshot.blockers[0]) });
      }
      if (
        input.acknowledgedScopeHash !== snapshot.task.scope_hash
        || input.acknowledgedPayoutCents !== snapshot.task.hustler_payout_cents
      ) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The task terms changed. Reload before offering availability.' });
      }
      const availableFrom = new Date(input.availableFrom);
      const availableUntil = new Date(input.availableUntil);
      if (availableUntil.getTime() <= Date.now()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Availability must include a future window.' });
      }
      const deadline = snapshot.task.deadline ? new Date(snapshot.task.deadline).getTime() : null;
      if (deadline !== null && availableFrom.getTime() > deadline) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Availability begins after the task deadline.' });
      }
      if (snapshot.task.link_kind === 'DIRECT_INVITE' && !snapshot.task.claimed_by_user_id) {
        const claim = await query<{ claimed_by_user_id: string }>(
          `INSERT INTO task_direct_invite_claims
             (share_link_id, claimed_by_user_id, eligibility_policy_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (share_link_id) DO NOTHING
           RETURNING claimed_by_user_id`,
          [snapshot.task.link_id, ctx.user.id, EXTERNAL_TASK_BRIDGE_POLICY_VERSION],
        );
        if (!claim.rows[0]) {
          const winner = await query<{ claimed_by_user_id: string }>(
            'SELECT claimed_by_user_id FROM task_direct_invite_claims WHERE share_link_id = $1',
            [snapshot.task.link_id],
          );
          if (winner.rows[0]?.claimed_by_user_id !== ctx.user.id) {
            throw new TRPCError({ code: 'CONFLICT', message: 'This private provider invitation has already been claimed.' });
          }
        } else {
          await query(
            `INSERT INTO task_external_bridge_events
               (share_link_id, task_id, event_type, actor_id, source_channel, payload_hash)
             VALUES ($1, $2, 'DIRECT_INVITE_CLAIMED', $3, $4, $5)`,
            [snapshot.task.link_id, snapshot.task.task_id, ctx.user.id, snapshot.task.source_channel, hashExternalShareToken(ctx.user.id)],
          );
        }
      }
      const application = await query<{ id: string }>(
        `INSERT INTO task_applications
           (id, task_id, hustler_id, message, status, counter_offer_round, created_at, updated_at)
         SELECT gen_random_uuid(), l.task_id, $2, $3, 'pending', 0, NOW(), NOW()
           FROM task_external_share_links l WHERE l.id = $1
         ON CONFLICT (task_id, hustler_id)
           WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired')
         DO NOTHING RETURNING id`,
        [snapshot.task.link_id, ctx.user.id, input.message],
      );
      if (!application.rows[0]) {
        throw new TRPCError({ code: 'CONFLICT', message: 'You already have an active offer for this task.' });
      }
      const termsHash = externalOfferTermsHash({
        task: snapshot.task,
        availableFrom: input.availableFrom,
        availableUntil: input.availableUntil,
      });
      const offer = await query<{ id: string; created_at: string }>(
        `INSERT INTO task_external_offers
           (share_link_id, task_id, application_id, hustler_id, source_channel,
            scope_hash, payout_cents, availability_start, availability_end,
            terms_hash, eligibility_policy_version, eligibility_evidence, offer_kind)
         SELECT l.id, l.task_id, $2, $3, l.source_channel, l.scope_hash, l.payout_cents,
                $4, $5, $6, $7, $8::jsonb,
                CASE l.link_kind WHEN 'DIRECT_INVITE' THEN 'DIRECT_ACCEPTANCE' ELSE 'OPEN_OFFER' END
           FROM task_external_share_links l WHERE l.id = $1
         RETURNING id, created_at`,
        [
          snapshot.task.link_id,
          application.rows[0].id,
          ctx.user.id,
          input.availableFrom,
          input.availableUntil,
          termsHash,
          EXTERNAL_TASK_BRIDGE_POLICY_VERSION,
          JSON.stringify({ identityVerified: true, trustTier: snapshot.user.trust_tier, risk: snapshot.task.risk_level }),
        ],
      );
      await query(
        `INSERT INTO task_external_bridge_events
           (share_link_id, offer_id, task_id, event_type, actor_id, source_channel, payload_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.task.link_id, offer.rows[0].id, snapshot.task.task_id,
          snapshot.task.link_kind === 'DIRECT_INVITE' ? 'SCOPE_ACCEPTED' : 'OFFER_SUBMITTED',
          ctx.user.id, snapshot.task.source_channel, termsHash],
      );
        return {
          offerId: offer.rows[0].id,
          status: 'SUBMITTED' as const,
          submittedAt: offer.rows[0].created_at,
          taskId: snapshot.task.task_id,
          posterId: snapshot.task.poster_id,
          taskTitle: snapshot.task.title,
          submissionKind: snapshot.task.link_kind === 'DIRECT_INVITE' ? 'DIRECT_ACCEPTANCE' as const : 'OPEN_OFFER' as const,
        };
      });
      await notifyApplicationReceived(submitted.posterId, submitted.taskId, submitted.taskTitle);
      return {
        offerId: submitted.offerId,
        status: submitted.status,
        submittedAt: submitted.submittedAt,
        submissionKind: submitted.submissionKind,
      };
    }),
});
