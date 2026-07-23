import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../db.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import { isExactCanonicalPaymentAmount } from '../services/EscrowPaymentPolicy.js';
import { EscrowService } from '../services/EscrowService.js';
import {
  isLocalCertificationPaymentIntentId,
  localCertificationPaymentEnabled,
  LocalCertificationPaymentProvider,
} from '../services/LocalCertificationPaymentProvider.js';
import { paymentCreationErrorCause } from '../services/NewPaymentCreationGuard.js';
import { StripeService } from '../services/StripeService.js';
import { posterProcedure, Schemas } from '../trpc.js';
import { getStripe } from './escrow-common.js';

function canonicalPrice(raw: number | string | null): number | null {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  return Math.round(Number(raw));
}

async function retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  try {
    return await stripeBreaker.execute(() => getStripe().paymentIntents.retrieve(id, { expand: ['latest_charge'] }));
  } catch {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment intent not found or could not be verified' });
  }
}

function assertPaymentIntent(pi: Stripe.PaymentIntent, escrow: { amount: number; task_id: string }): void {
  if (pi.status !== 'succeeded') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Payment intent has not succeeded (status: ${pi.status})` });
  }
  if (pi.amount !== escrow.amount) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment intent amount does not match escrow amount' });
  }
  if (pi.metadata?.task_id !== escrow.task_id) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment intent was not created for this task' });
  }
  const charge = (pi as Stripe.PaymentIntent & { latest_charge?: { refunded?: boolean } }).latest_charge;
  if (charge?.refunded) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment intent has already been refunded and cannot be reused' });
  }
}

export const escrowPaymentProcedures = {
  createPaymentIntent: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      amount: z.number().int().positive().max(99999900).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!StripeService.isConfigured() && !localCertificationPaymentEnabled()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment processing is not configured' });
      }
      const taskRow = await db.query<{
        price: number | string | null;
        automation_classification: string | null;
      }>(
        'SELECT price, automation_classification FROM tasks WHERE id = $1 AND poster_id = $2',
        [input.taskId, ctx.user.id]
      );
      if (!taskRow.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      const taskPriceCents = canonicalPrice(taskRow.rows[0].price);
      if (taskPriceCents == null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task price has not been set. Price the task before creating an escrow.' });
      }
      const amount = input.amount ?? taskPriceCents;
      if (!isExactCanonicalPaymentAmount(taskPriceCents, amount)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Payment amount (${amount}) must exactly match task price (${taskPriceCents})` });
      }
      const escrowRow = await db.query<{ id: string; platform_fee_cents: number | string | null }>(
        `SELECT id, platform_fee_cents FROM escrows WHERE task_id = $1 AND state = 'PENDING' AND amount = $2
         ORDER BY created_at DESC LIMIT 1`,
        [input.taskId, taskPriceCents]
      );
      if (!escrowRow.rows[0]) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No pending escrow exactly matches the canonical task price' });
      }
      const escrowId = escrowRow.rows[0].id;
      const platformFeeCents = canonicalPrice(escrowRow.rows[0].platform_fee_cents);
      const useLocalCertificationProvider = taskRow.rows[0].automation_classification === 'CONTROLLED_TEST'
        && localCertificationPaymentEnabled();
      if (!useLocalCertificationProvider && !StripeService.isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment processing is not configured' });
      }
      const result = useLocalCertificationProvider
        ? await LocalCertificationPaymentProvider.createIntent({
            taskId: input.taskId, posterId: ctx.user.id, escrowId, amountCents: amount,
          })
        : await StripeService.createPaymentIntent({
            taskId: input.taskId, posterId: ctx.user.id, escrowId, amount, platformFeeCents,
          });
      if (!result.success) {
        const cause = paymentCreationErrorCause(result.error.code);
        throw new TRPCError({
          code: cause ? 'PRECONDITION_FAILED' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
          ...(cause ? { cause } : {}),
        });
      }
      return {
        escrowId,
        paymentIntentId: result.data.paymentIntentId,
        clientSecret: result.data.clientSecret,
        amountCents: result.data.amount,
      };
    }),

  confirmLocalTestPayment: posterProcedure
    .input(z.object({
      paymentIntentId: z.string().regex(/^pi_hxos_test_[a-f0-9]{32}$/),
      clientSecret: z.string().min(64).max(255),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await LocalCertificationPaymentProvider.confirmIntent({
        paymentIntentId: input.paymentIntentId,
        clientSecret: input.clientSecret,
        posterId: ctx.user.id,
      });
      if (!result.success) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: result.error.message });
      }
      return result.data;
    }),

  confirmFunding: posterProcedure
    .input(Schemas.fundEscrow)
    .mutation(async ({ ctx, input }) => {
      const result = await EscrowService.getById(input.escrowId);
      if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      if (result.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the escrow creator can confirm funding' });
      }
      const escrow = result.data as typeof result.data & { amount: number; task_id: string };
      if (isLocalCertificationPaymentIntentId(input.stripePaymentIntentId)) {
        const verified = await LocalCertificationPaymentProvider.verifySucceededIntent({
          paymentIntentId: input.stripePaymentIntentId,
          escrowId: input.escrowId,
          taskId: escrow.task_id,
          posterId: ctx.user.id,
          amountCents: escrow.amount,
        });
        if (!verified.success) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: verified.error.message });
        }
      } else {
        const paymentIntent = await retrievePaymentIntent(input.stripePaymentIntentId);
        assertPaymentIntent(paymentIntent, escrow);
      }
      const duplicate = await db.query<{ id: string }>(
        'SELECT id FROM escrows WHERE stripe_payment_intent_id = $1 AND id != $2',
        [input.stripePaymentIntentId, input.escrowId]
      );
      if (duplicate.rows[0]) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Payment intent is already associated with another escrow' });
      }
      const funded = await EscrowService.fund({
        escrowId: input.escrowId,
        stripePaymentIntentId: input.stripePaymentIntentId,
      });
      if (!funded.success) throw new TRPCError({ code: 'BAD_REQUEST', message: funded.error.message });
      return funded.data;
    }),
};
