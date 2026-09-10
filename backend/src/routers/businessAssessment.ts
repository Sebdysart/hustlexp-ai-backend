import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';
import { StaxAssessmentPaymentProvider } from '../services/payment/StaxAssessmentPaymentProvider.js';
import { NotificationService } from '../services/NotificationService.js';

function pacificDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export const businessAssessmentRouter = router({
  createPaymentIntent: protectedProcedure
    .input(z.object({ assessmentRequestId:z.string().uuid(), paymentMethodId:z.string().min(1) }).strict())
    .mutation(async ({ctx,input}) => {
      const r=await db.query<any>(`SELECT a.id,a.task_draft_id,a.business_organization_id,a.assessment_fee_cents,a.status FROM business_assessment_requests a JOIN task_drafts d ON d.id=a.task_draft_id WHERE a.id=$1 AND d.poster_user_id=$2 LIMIT 1`,[input.assessmentRequestId,ctx.user.id]);
      const a=r.rows[0]; if(!a) throw new TRPCError({code:'NOT_FOUND',message:'Assessment request was not found.'});
      if(a.status!=='AWAITING_CUSTOMER') throw new TRPCError({code:'PRECONDITION_FAILED',message:'This assessment is not currently awaiting customer action.'});
      if(a.assessment_fee_cents===null||a.assessment_fee_cents<=0) throw new TRPCError({code:'PRECONDITION_FAILED',message:'This assessment does not require payment.'});
      const existing=await db.query<any>('SELECT status FROM assessment_payments WHERE assessment_request_id=$1 LIMIT 1',[a.id]); if(existing.rows[0]?.status==='SUCCEEDED') throw new TRPCError({code:'PRECONDITION_FAILED',message:'This assessment fee has already been paid.'});
      const payment=await StaxAssessmentPaymentProvider.charge({assessmentRequestId:a.id,taskDraftId:a.task_draft_id,posterId:ctx.user.id,businessOrganizationId:a.business_organization_id,paymentMethodId:input.paymentMethodId,amountCents:a.assessment_fee_cents}); if(!payment.success) throw new TRPCError({code:'PRECONDITION_FAILED',message:payment.error.message});
      await db.transaction(async (query) => {
        await query(`INSERT INTO assessment_payments (assessment_request_id,task_draft_id,business_organization_id,poster_user_id,provider,provider_payment_id,amount_cents,status) VALUES ($1,$2,$3,$4,'stax',$5,$6,'SUCCEEDED') ON CONFLICT (assessment_request_id) DO UPDATE SET provider_payment_id=EXCLUDED.provider_payment_id,status='SUCCEEDED',updated_at=NOW()`,[a.id,a.task_draft_id,a.business_organization_id,ctx.user.id,payment.data.transactionId,payment.data.amountCents]);
        await NotificationService.createForBusinessInTransaction(query, a.business_organization_id, {
          type: 'ASSESSMENT_PAID',
          title: 'Assessment fee paid',
          message: 'The customer paid the onsite assessment fee.',
          entityType: 'assessment',
          entityId: a.id,
          actionUrl: `/business/claims/${a.task_draft_id}`,
          dedupeKey: `assessment-paid:${a.id}`,
        });
      });
      return {paymentIntentId:payment.data.transactionId,amountCents:payment.data.amountCents,status:'SUCCEEDED' as const};
    }),
  listForPosterDraft: protectedProcedure
    .input(z.object({ taskDraftId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const draft = await db.query(
        `SELECT id FROM task_drafts WHERE id = $1 AND poster_user_id = $2 LIMIT 1`,
        [input.taskDraftId, ctx.user.id],
      );
      if (!draft.rows[0]) throw new TRPCError({ code: 'NOT_FOUND' });
      const result = await db.query(
        `SELECT assessment.id, assessment.status, assessment.customer_message,
                assessment.proposed_window_start, assessment.proposed_window_end,
                assessment.scheduled_date, assessment.assessment_fee_cents, payment.status AS assessment_payment_status, org.display_name AS business_name
         FROM business_assessment_requests assessment
         JOIN business_organizations org ON org.id = assessment.business_organization_id
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         WHERE assessment.task_draft_id = $1
           AND assessment.status IN ('AWAITING_CUSTOMER', 'SCHEDULED', 'COMPLETED')
         ORDER BY assessment.created_at ASC`,
        [input.taskDraftId],
      );
      return result.rows;
    }),

  scheduleForPoster: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid(), scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .mutation(async ({ ctx, input }) => db.transaction(async (query) => {
      const result = await query<{ id: string; task_draft_id: string; business_organization_id: string; proposed_window_start: Date; proposed_window_end: Date; assessment_fee_cents: number | null; assessment_payment_status: string | null }>(
        `SELECT assessment.id, assessment.task_draft_id, assessment.business_organization_id, assessment.proposed_window_start, assessment.proposed_window_end, assessment.assessment_fee_cents, payment.status AS assessment_payment_status
         FROM business_assessment_requests assessment
         JOIN task_drafts draft ON draft.id = assessment.task_draft_id
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         WHERE assessment.id = $1 AND assessment.status = 'AWAITING_CUSTOMER'
           AND draft.poster_user_id = $2 FOR UPDATE OF assessment`,
        [input.assessmentRequestId, ctx.user.id],
      );
      const assessment = result.rows[0];
      if (!assessment) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment request is no longer available.' });
      if (assessment.assessment_fee_cents !== null && assessment.assessment_fee_cents > 0 && assessment.assessment_payment_status !== 'SUCCEEDED') throw new TRPCError({ code:'PRECONDITION_FAILED', message:'The assessment fee must be paid before an assessment date can be scheduled.' });
      if (input.scheduledDate < pacificDate(assessment.proposed_window_start) || input.scheduledDate > pacificDate(assessment.proposed_window_end)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selected date is outside the approved assessment window.' });
      }
      await query(
        `UPDATE business_assessment_requests SET status = 'SCHEDULED', scheduled_date = $2::date,
           customer_selected_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [input.assessmentRequestId, input.scheduledDate],
      );
      await NotificationService.createForBusinessInTransaction(query, assessment.business_organization_id, {
        type: 'ASSESSMENT_SCHEDULED',
        title: 'Assessment scheduled',
        message: 'The customer selected a date for the onsite assessment.',
        entityType: 'assessment',
        entityId: assessment.id,
        actionUrl: `/business/claims/${assessment.task_draft_id}`,
        dedupeKey: `assessment-scheduled:${assessment.id}`,
      });
      return { ok: true };
    })),

  declineForPoster: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{ id: string }>(
        `UPDATE business_assessment_requests assessment
         SET status = 'CUSTOMER_DECLINED', updated_at = NOW()
         FROM task_drafts draft
         WHERE assessment.id = $1
           AND draft.id = assessment.task_draft_id
           AND draft.poster_user_id = $2
           AND assessment.status = 'AWAITING_CUSTOMER'
           AND NOT EXISTS (SELECT 1 FROM assessment_payments payment WHERE payment.assessment_request_id = assessment.id AND payment.status = 'SUCCEEDED')
         RETURNING assessment.id`,
        [input.assessmentRequestId, ctx.user.id],
      );
      if (!result.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment can no longer be declined.' });
      return { ok: true };
    }),

  complete: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{ id: string; task_draft_id: string; poster_user_id: string }>(
        `UPDATE business_assessment_requests assessment
         SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
         FROM business_memberships membership
         WHERE assessment.id = $1 AND assessment.status = 'SCHEDULED'
           AND membership.organization_id = assessment.business_organization_id
           AND membership.user_id = $2 AND membership.status = 'ACTIVE'
         RETURNING assessment.id, assessment.task_draft_id, (SELECT poster_user_id FROM task_drafts WHERE id = assessment.task_draft_id) AS poster_user_id`,
        [input.assessmentRequestId, ctx.user.id],
      );
      if (!result.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment cannot be completed.' });
      await NotificationService.create({
        userId: result.rows[0].poster_user_id,
        type: 'ASSESSMENT_COMPLETED',
        title: 'Assessment completed',
        message: 'The onsite assessment is complete. The business can now prepare your quote.',
        entityType: 'assessment',
        entityId: result.rows[0].id,
        actionUrl: `/dashboard/drafts/${result.rows[0].task_draft_id}`,
        dedupeKey: `assessment-completed:${result.rows[0].id}`,
      });
      return { ok: true };
    }),
});



