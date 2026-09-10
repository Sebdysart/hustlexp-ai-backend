import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';

const statuses = ['PENDING','VIEWED','QUOTED','REJECTED','CANCELLED','EXPIRED'] as const;
type Status = typeof statuses[number];
async function expire(id: string) { await db.query(`UPDATE business_task_proposals SET status='EXPIRED', responded_at=COALESCE(responded_at,NOW()), updated_at=NOW() WHERE id=$1 AND status IN ('PENDING','VIEWED') AND expires_at<=NOW()`, [id]); }

export const businessProposalRouter = router({
  list: protectedProcedure.input(z.object({ status: z.enum(statuses).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict().optional()).query(async ({ ctx, input }) => {
    const status = input?.status ?? null;
    const limit = input?.limit ?? 50;
    await db.query(`UPDATE business_task_proposals p SET status='EXPIRED', responded_at=COALESCE(p.responded_at,NOW()), updated_at=NOW() WHERE p.status IN ('PENDING','VIEWED') AND p.expires_at<=NOW() AND EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.organization_id=p.business_organization_id AND bm.user_id=$1 AND bm.status='ACTIVE')`, [ctx.user.id]);
    const result = await db.query<any>(`SELECT p.id proposal_id,p.task_draft_id,p.business_organization_id,COALESCE(bo.display_name,bo.legal_name) business_name,p.status,p.quote_id,d.title,d.scope_summary,p.expires_at,p.viewed_at,p.responded_at,p.created_at FROM business_task_proposals p JOIN task_drafts d ON d.id=p.task_draft_id JOIN business_organizations bo ON bo.id=p.business_organization_id WHERE EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.organization_id=p.business_organization_id AND bm.user_id=$1 AND bm.status='ACTIVE') AND ($2::text IS NULL OR p.status=$2) ORDER BY CASE WHEN p.status IN ('PENDING','VIEWED') THEN 0 ELSE 1 END,p.created_at DESC LIMIT $3`, [ctx.user.id, status, limit]);
    return result.rows.map((row) => ({ ...row, expires_at: row.expires_at.toISOString(), viewed_at: row.viewed_at?.toISOString() ?? null, responded_at: row.responded_at?.toISOString() ?? null, created_at: row.created_at.toISOString() }));
  }),
  get: protectedProcedure.input(z.object({ proposalId: z.string().uuid() }).strict()).query(async ({ ctx, input }) => {
    await expire(input.proposalId);
    const result = await db.query<any>(`SELECT p.id proposal_id,p.task_draft_id,p.business_organization_id,COALESCE(bo.display_name,bo.legal_name) business_name,p.status,p.quote_id,d.title,d.scope_summary,d.raw_input,p.expires_at,p.viewed_at,p.responded_at,p.rejection_reason,p.created_at FROM business_task_proposals p JOIN task_drafts d ON d.id=p.task_draft_id JOIN business_organizations bo ON bo.id=p.business_organization_id WHERE p.id=$1 AND EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.organization_id=p.business_organization_id AND bm.user_id=$2 AND bm.status='ACTIVE') LIMIT 1`, [input.proposalId, ctx.user.id]);
    const proposal = result.rows[0];
    if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Business proposal not found' });
    if (proposal.status === 'PENDING') { await db.query(`UPDATE business_task_proposals SET status='VIEWED', viewed_at=COALESCE(viewed_at,NOW()), updated_at=NOW() WHERE id=$1 AND status='PENDING'`, [proposal.proposal_id]); proposal.status='VIEWED'; proposal.viewed_at=new Date(); }
    return { ...proposal, expires_at: proposal.expires_at.toISOString(), viewed_at: proposal.viewed_at?.toISOString() ?? null, responded_at: proposal.responded_at?.toISOString() ?? null, created_at: proposal.created_at.toISOString() };
  }),
  reject: protectedProcedure.input(z.object({ proposalId: z.string().uuid(), reason: z.string().trim().max(1000).optional() }).strict()).mutation(async ({ ctx, input }) => db.transaction(async (tx) => {
    const proposal = (await tx<any>(`SELECT p.id,p.status,p.expires_at FROM business_task_proposals p WHERE p.id=$1 AND EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.organization_id=p.business_organization_id AND bm.user_id=$2 AND bm.status='ACTIVE') FOR UPDATE`, [input.proposalId, ctx.user.id])).rows[0];
    if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Business proposal not found' });
    if (proposal.expires_at <= new Date() && ['PENDING','VIEWED'].includes(proposal.status)) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This task proposal has expired.' });
    if (!['PENDING','VIEWED'].includes(proposal.status)) throw new TRPCError({ code: 'CONFLICT', message: `This proposal is already ${proposal.status.toLowerCase()}.` });
    await tx(`UPDATE business_task_proposals SET status='REJECTED', rejection_reason=$2, responded_at=NOW(), updated_at=NOW() WHERE id=$1`, [proposal.id, input.reason ?? null]);
    return { ok: true, proposal_id: proposal.id, status: 'REJECTED' as const };
  })),
});
export type BusinessProposalRouter = typeof businessProposalRouter;
