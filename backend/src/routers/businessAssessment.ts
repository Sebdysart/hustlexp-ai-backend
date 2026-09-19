import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';
import { NotificationService } from '../services/NotificationService.js';
import { assessmentPaymentStatus, confirmAssessmentPayment, createAssessmentPayment } from '../services/AssessmentPaymentService.js';

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
    .input(z.object({ assessmentRequestId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => createAssessmentPayment(input.assessmentRequestId, ctx.user.id)),
  confirmPayment: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid(), clientSecret: z.string().min(32) }).strict())
    .mutation(({ ctx, input }) => confirmAssessmentPayment(input.assessmentRequestId, ctx.user.id, input.clientSecret)),
  paymentStatus: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => assessmentPaymentStatus(input.assessmentRequestId, ctx.user.id)),
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
                assessment.scheduled_date, assessment.assessment_fee_cents,
                CASE WHEN payment.status = 'PENDING' AND intent.status = 'succeeded'
                  THEN 'PROCESSING' ELSE payment.status END AS assessment_payment_status,
                org.display_name AS business_name
         FROM business_assessment_requests assessment
         JOIN business_organizations org ON org.id = assessment.business_organization_id
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         LEFT JOIN hxos_local_test_assessment_intents intent ON intent.assessment_payment_id = payment.id
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
      const result = await query<{ id: string; status: string; scheduled_date: string | null; task_draft_id: string; business_organization_id: string; proposed_window_start: Date; proposed_window_end: Date; assessment_fee_cents: number | null; assessment_payment_status: string | null }>(
        `SELECT assessment.id, assessment.status, assessment.scheduled_date::text AS scheduled_date, assessment.task_draft_id, assessment.business_organization_id, assessment.proposed_window_start, assessment.proposed_window_end, assessment.assessment_fee_cents, payment.status AS assessment_payment_status
         FROM business_assessment_requests assessment
         JOIN task_drafts draft ON draft.id = assessment.task_draft_id
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         WHERE assessment.id = $1 AND draft.poster_user_id = $2 FOR UPDATE OF assessment`,
        [input.assessmentRequestId, ctx.user.id],
      );
      const assessment = result.rows[0];
      if (!assessment) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment request is no longer available.' });
      if (assessment.status === 'SCHEDULED' && assessment.scheduled_date &&
          assessment.scheduled_date === input.scheduledDate) return { ok: true, replayed: true };
      if (assessment.status !== 'AWAITING_CUSTOMER') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment request is no longer available.' });
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
           AND NOT EXISTS (SELECT 1 FROM assessment_payments payment WHERE payment.assessment_request_id = assessment.id)
         RETURNING assessment.id`,
        [input.assessmentRequestId, ctx.user.id],
      );
      if (!result.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment can no longer be declined.' });
      return { ok: true };
    }),

  complete: protectedProcedure
    .input(z.object({ assessmentRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => db.transaction(async (query) => {
      const result = await query<{ id: string; task_draft_id: string; poster_user_id: string; status: string }>(
        `SELECT assessment.id, assessment.task_draft_id, draft.poster_user_id, assessment.status
         FROM business_assessment_requests assessment
         JOIN task_drafts draft ON draft.id = assessment.task_draft_id
         WHERE assessment.id = $1
           AND EXISTS (SELECT 1 FROM business_memberships membership
             WHERE membership.organization_id = assessment.business_organization_id
               AND membership.user_id = $2 AND membership.status = 'ACTIVE')
           AND business_membership_has_action(assessment.business_organization_id,$2,'ASSIGN_CREW')
         FOR UPDATE OF assessment`,
        [input.assessmentRequestId, ctx.user.id],
      );
      const assessment = result.rows[0];
      if (!assessment || !['SCHEDULED', 'COMPLETED'].includes(assessment.status)) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment cannot be completed.' });
      }
      if (assessment.status === 'COMPLETED') return { ok: true, replayed: true };
      await query(
        `UPDATE business_assessment_requests
         SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'SCHEDULED'`,
        [assessment.id],
      );
      await NotificationService.createInTransaction(query, {
        userId: assessment.poster_user_id,
        type: 'ASSESSMENT_COMPLETED',
        title: 'Assessment completed',
        message: 'The onsite assessment is complete. The business can now prepare your quote.',
        entityType: 'assessment',
        entityId: assessment.id,
        actionUrl: `/dashboard/drafts/${assessment.task_draft_id}`,
        dedupeKey: `assessment-completed:${assessment.id}`,
      });
      return { ok: true };
    })),
});



