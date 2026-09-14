import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';
import { NotificationService } from '../services/NotificationService.js';

const contextType = z.enum(['GENERAL', 'TASK_DRAFT', 'TASK', 'PROPOSAL', 'QUOTE']);
const SupportContextLookupSchema = z.object({ contextType, taskDraftId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), proposalId: z.string().uuid().optional(), quoteId: z.string().uuid().optional(), businessOrganizationId: z.string().uuid().optional() }).strict();

async function findActiveSupportThread(input: { userId: string; contextType: 'GENERAL' | 'TASK_DRAFT' | 'TASK' | 'PROPOSAL' | 'QUOTE'; taskDraftId?: string; taskId?: string; proposalId?: string; quoteId?: string; businessOrganizationId?: string }) {
  const result = await db.query(`SELECT id,opened_by_user_id,business_organization_id,status,subject,context_type,task_draft_id,task_id,proposal_id,quote_id,source_route,resolved_at,created_at,updated_at FROM support_threads WHERE opened_by_user_id=$1 AND status IN ('OPEN','IN_PROGRESS') AND context_type=$2 AND task_draft_id IS NOT DISTINCT FROM $3::uuid AND task_id IS NOT DISTINCT FROM $4::uuid AND proposal_id IS NOT DISTINCT FROM $5::uuid AND quote_id IS NOT DISTINCT FROM $6::uuid AND business_organization_id IS NOT DISTINCT FROM $7::uuid ORDER BY created_at DESC LIMIT 1`, [input.userId, input.contextType, input.taskDraftId ?? null, input.taskId ?? null, input.proposalId ?? null, input.quoteId ?? null, input.businessOrganizationId ?? null]);
  return result.rows[0] ?? null;
}

export const supportRouter = router({
  createThread: protectedProcedure
    .input(z.object({ subject: z.string().trim().min(1).max(160), message: z.string().trim().min(1).max(4000), contextType, taskDraftId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), proposalId: z.string().uuid().optional(), quoteId: z.string().uuid().optional(), businessOrganizationId: z.string().uuid().optional(), sourceRoute: z.string().trim().max(500).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (input.businessOrganizationId) await db.query(`SELECT business_require_action($1, $2, 'READ_WORKSPACE')`, [input.businessOrganizationId, ctx.user.id]);
      const existingThread = await findActiveSupportThread({ userId: ctx.user.id, contextType: input.contextType, taskDraftId: input.taskDraftId, taskId: input.taskId, proposalId: input.proposalId, quoteId: input.quoteId, businessOrganizationId: input.businessOrganizationId });
      if (existingThread) return { ok: true as const, threadId: existingThread.id as string, reused: true as const };
      const result = await db.query(`WITH inserted_thread AS (INSERT INTO support_threads (opened_by_user_id,business_organization_id,status,subject,context_type,task_draft_id,task_id,proposal_id,quote_id,source_route) VALUES ($1,$2,'OPEN',$3,$4,$5,$6,$7,$8,$9) RETURNING id) INSERT INTO support_messages (thread_id,sender_user_id,sender_kind,body) SELECT id,$1,'USER',$10 FROM inserted_thread RETURNING thread_id`, [ctx.user.id, input.businessOrganizationId ?? null, input.subject, input.contextType, input.taskDraftId ?? null, input.taskId ?? null, input.proposalId ?? null, input.quoteId ?? null, input.sourceRoute ?? null, input.message]);
      const threadId = result.rows[0].thread_id as string;
      await NotificationService.createForOperationsInTransaction(db.query.bind(db), { type: 'SUPPORT_REQUEST_CREATED', title: 'New support request', message: input.subject, entityType: 'support_thread', entityId: threadId, actionUrl: `/ops/support/${threadId}`, dedupeKey: `support-created:${threadId}` });
      return { ok: true as const, threadId, reused: false as const };
    }),
  getContextThread: protectedProcedure
    .input(SupportContextLookupSchema)
    .query(async ({ ctx, input }) => {
      if (input.businessOrganizationId) await db.query(`SELECT business_require_action($1, $2, 'READ_WORKSPACE')`, [input.businessOrganizationId, ctx.user.id]);
      const thread = await findActiveSupportThread({ userId: ctx.user.id, contextType: input.contextType, taskDraftId: input.taskDraftId, taskId: input.taskId, proposalId: input.proposalId, quoteId: input.quoteId, businessOrganizationId: input.businessOrganizationId });
      if (!thread) return { ok: true as const, thread: null, messages: [] };
      const messages = await db.query(`SELECT id,sender_user_id,sender_kind,body,created_at FROM support_messages WHERE thread_id=$1 ORDER BY created_at ASC`, [thread.id]);
      return { ok: true as const, thread, messages: messages.rows };
    }),
  getMyThread: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }).strict())
    .query(async ({ ctx, input }) => {
      const result = await db.query(`SELECT id,opened_by_user_id,business_organization_id,status,subject,context_type,task_draft_id,task_id,proposal_id,quote_id,source_route,resolved_at,created_at,updated_at FROM support_threads WHERE id=$1 LIMIT 1`, [input.threadId]);
      if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found.' });
      const thread = result.rows[0];
      if (thread.opened_by_user_id !== ctx.user.id) {
        if (!thread.business_organization_id) throw new TRPCError({ code: 'FORBIDDEN' });
        await db.query(`SELECT business_require_action($1, $2, 'READ_WORKSPACE')`, [thread.business_organization_id, ctx.user.id]);
      }
      const messages = await db.query(`SELECT id,sender_user_id,sender_kind,body,created_at FROM support_messages WHERE thread_id=$1 ORDER BY created_at ASC`, [input.threadId]);
      return { ok: true as const, thread, messages: messages.rows };
    }),
  reply: protectedProcedure
    .input(z.object({ threadId: z.string().uuid(), message: z.string().trim().min(1).max(4000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(`SELECT opened_by_user_id,business_organization_id,status FROM support_threads WHERE id=$1 LIMIT 1`, [input.threadId]);
      if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND' });
      const thread = result.rows[0];
      if (thread.opened_by_user_id !== ctx.user.id) {
        if (!thread.business_organization_id) throw new TRPCError({ code: 'FORBIDDEN' });
        await db.query(`SELECT business_require_action($1, $2, 'READ_WORKSPACE')`, [thread.business_organization_id, ctx.user.id]);
      }
      if (thread.status === 'RESOLVED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This support request has already been resolved.' });
      const inserted = await db.query(`WITH inserted_message AS (INSERT INTO support_messages (thread_id,sender_user_id,sender_kind,body) VALUES ($1,$2,'USER',$3) RETURNING id) UPDATE support_threads st SET updated_at=NOW() FROM inserted_message im WHERE st.id=$1 RETURNING im.id AS message_id`, [input.threadId, ctx.user.id, input.message]);
      const messageId = inserted.rows[0].message_id as string;
      await NotificationService.createForOperationsInTransaction(db.query.bind(db), { type: 'SUPPORT_USER_REPLY', title: 'New support reply', message: 'A user replied to a support conversation.', entityType: 'support_thread', entityId: input.threadId, actionUrl: `/ops/support/${input.threadId}`, dedupeKey: `support-user-reply:${messageId}` });
      return { ok: true as const };
    }),
});

export type SupportRouter = typeof supportRouter;
