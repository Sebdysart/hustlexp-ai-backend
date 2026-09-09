import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';

function pacificDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export const businessAssessmentRouter = router({
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
      const result = await query<{ id: string; proposed_window_start: Date; proposed_window_end: Date; assessment_fee_cents: number | null; assessment_payment_status: string | null }>(
        `SELECT assessment.id, assessment.proposed_window_start, assessment.proposed_window_end, assessment.assessment_fee_cents, payment.status AS assessment_payment_status
         FROM business_assessment_requests assessment
         JOIN task_drafts draft ON draft.id = assessment.task_draft_id
         LEFT JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         WHERE assessment.id = $1 AND assessment.status = 'AWAITING_CUSTOMER'
           AND draft.poster_user_id = $2 FOR UPDATE`,
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
      const result = await db.query<{ id: string }>(
        `UPDATE business_assessment_requests assessment
         SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
         FROM business_memberships membership
         WHERE assessment.id = $1 AND assessment.status = 'SCHEDULED'
           AND membership.organization_id = assessment.business_organization_id
           AND membership.user_id = $2 AND membership.status = 'ACTIVE'
         RETURNING assessment.id`,
        [input.assessmentRequestId, ctx.user.id],
      );
      if (!result.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment cannot be completed.' });
      return { ok: true };
    }),
});


