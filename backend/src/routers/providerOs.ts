import { listProviderOsQuotes, getProviderOsQuote } from '../services/ProviderOsQuoteHistory.js';
import { db } from '../db.js';
import { getProviderOsAccessStatus } from '../services/ProviderOsAccess.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, operationsAdminProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import {
  acceptProviderOsInvite,
  createProviderOsInvite,
  getProviderOsDraft,
  listProviderOsClients,
  listProviderOsDrafts,
  previewProviderOsInvite,
  setProviderOsDraftQuote,
} from '../services/ProviderOsService.js';

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    const code = result.error.code;
    throw new TRPCError({
      code:
        code === 'NOT_FOUND' ? 'NOT_FOUND'
          : code === 'FORBIDDEN' ? 'FORBIDDEN'
            : code === 'INVALID_STATE' ? 'CONFLICT'
              : 'BAD_REQUEST',
      message: result.error.message,
    });
  }
  return result.data;
}

export const providerOsRouter = router({
  accessStatus: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => getProviderOsAccessStatus({ ...input, actorId: ctx.user.id })),

  inspectEntitlement: operationsAdminProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(async ({ input }) => {
      const result = await db.query(`SELECT * FROM provider_os_entitlements WHERE organization_id = $1`, [input.organizationId]);
      return { entitlement: result.rows[0] ?? null };
    }),

  setEntitlement: operationsAdminProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      status: z.enum(['active', 'suspended', 'revoked']),
      expiresAt: z.string().datetime().nullable().optional(),
      reason: z.string().trim().min(1).max(2000),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      if (input.status === 'active' && input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expiry must be in the future.' });
      }
      return db.transaction(async (query) => {
        // Serialize grants/revocation with premium acquisition transactions.
        const org = await query<{ status: string; provider_enabled: boolean }>(
          `SELECT status, provider_enabled FROM business_organizations WHERE id = $1 FOR UPDATE`, [input.organizationId]);
        if (!org.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Business not found.' });
        if (input.status === 'active' && (org.rows[0].status !== 'ACTIVE' || !org.rows[0].provider_enabled)) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Business must be active and provider-enabled.' });
        }
        const before = await query(`SELECT * FROM provider_os_entitlements WHERE organization_id = $1`, [input.organizationId]);
        const result = await query(`INSERT INTO provider_os_entitlements
          (organization_id, status, starts_at, expires_at, granted_by_user_id, granted_at,
           changed_by_user_id, suspended_at, revoked_at, reason)
          VALUES ($1, $2::text, NOW(), $3::timestamptz,
            CASE WHEN $2::text = 'active' THEN $4::uuid ELSE NULL END,
            CASE WHEN $2::text = 'active' THEN NOW() ELSE NULL END, $4,
            CASE WHEN $2::text = 'suspended' THEN NOW() ELSE NULL END,
            CASE WHEN $2::text = 'revoked' THEN NOW() ELSE NULL END, $5)
          ON CONFLICT (organization_id) DO UPDATE SET status = EXCLUDED.status,
            starts_at = CASE WHEN EXCLUDED.status = 'active' THEN NOW() ELSE provider_os_entitlements.starts_at END,
            expires_at = CASE WHEN EXCLUDED.status = 'active' THEN EXCLUDED.expires_at ELSE provider_os_entitlements.expires_at END,
            granted_by_user_id = COALESCE(EXCLUDED.granted_by_user_id, provider_os_entitlements.granted_by_user_id),
            granted_at = COALESCE(EXCLUDED.granted_at, provider_os_entitlements.granted_at),
            changed_by_user_id = EXCLUDED.changed_by_user_id, suspended_at = EXCLUDED.suspended_at,
            revoked_at = EXCLUDED.revoked_at, reason = EXCLUDED.reason, updated_at = NOW()
          RETURNING *`, [input.organizationId, input.status, input.status === 'active' ? input.expiresAt ?? null : null, ctx.user.id, input.reason]);
        await query(`INSERT INTO ops_action_audit (actor_user_id, actor_label, action, target_type, target_id, meta)
          VALUES ($1, 'ops', 'PROVIDER_OS_ENTITLEMENT_CHANGED', 'business_organization', $2, $3::jsonb)`,
          [ctx.user.id, input.organizationId, JSON.stringify({ before: before.rows[0] ?? null, after: result.rows[0] })]);
        return { entitlement: result.rows[0] };
      });
    }),

  createInvite: protectedProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      intendedEmail: z.string().trim().email().max(255).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await createProviderOsInvite({
        actorId: ctx.user.id,
        organizationId: input.organizationId,
        intendedEmail: input.intendedEmail ?? null,
      }),
    )),

  previewInvite: publicProcedure
    .input(z.object({
      token: z.string().trim().min(16).max(128),
    }).strict())
    .query(async ({ input }) => unwrap(
      await previewProviderOsInvite(input.token),
    )),

  acceptInvite: protectedProcedure
    .input(z.object({
      token: z.string().trim().min(16).max(128),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await acceptProviderOsInvite({
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        token: input.token,
      }),
    )),

  setQuote: protectedProcedure
    .input(z.object({
      draftId: z.string().uuid(),
      organizationId: z.string().uuid(),
      proposedCustomerTotalCents: z.number().int().positive(),
      proposedPayoutCents: z.number().int().positive(),
      arrivalWindowStart: z.string().datetime(),
      arrivalWindowEnd: z.string().datetime(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await setProviderOsDraftQuote({
        actorId: ctx.user.id,
        draftId: input.draftId,
        organizationId: input.organizationId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
      }),
    )),

  listQuotes: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(),
      cursor: z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict().optional(),
    }).strict())
    .query(({ ctx, input }) => listProviderOsQuotes({ ...input, actorId: ctx.user.id })),

  getQuote: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(), quoteId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => getProviderOsQuote({ ...input, actorId: ctx.user.id })),

  listClients: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(async ({ ctx, input }) => unwrap(await listProviderOsClients({ ...input, actorId: ctx.user.id }))),

  listDrafts: protectedProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      posterUserId: z.string().uuid().optional(),
    }).strict())
    .query(async ({ ctx, input }) => unwrap(
      await listProviderOsDrafts({
        actorId: ctx.user.id,
        organizationId: input.organizationId,
        posterUserId: input.posterUserId,
      }),
    )),

  getDraft: protectedProcedure
    .input(z.object({
      draftId: z.string().uuid(),
      organizationId: z.string().uuid(),
    }).strict())
    .query(async ({ ctx, input }) => unwrap(
      await getProviderOsDraft({
        actorId: ctx.user.id,
        draftId: input.draftId,
        organizationId: input.organizationId,
      }),
    )),
});
