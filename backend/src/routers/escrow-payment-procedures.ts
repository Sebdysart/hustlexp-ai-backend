import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { isExactCanonicalPaymentAmount } from '../services/EscrowPaymentPolicy.js';
import { EscrowService } from '../services/EscrowService.js';
import {
  isLocalCertificationPaymentIntentId,
  localCertificationPaymentEnabled,
  LocalCertificationPaymentProvider,
} from '../services/LocalCertificationPaymentProvider.js';
import {
  newPaymentCreationFailure,
  paymentCreationErrorCause,
  type NewPaymentLane,
} from '../services/NewPaymentCreationGuard.js';
import { resolvePaymentProvider } from '../services/payment/PaymentProviderResolver.js';
import { posterProcedure, Schemas } from '../trpc.js';

function canonicalPrice(raw: number | string | null): number | null {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  return Math.round(Number(raw));
}

function requirePaymentCreation(lane: NewPaymentLane): void {
  const frozen = newPaymentCreationFailure(lane);
  if (!frozen) return;
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: frozen.error.message,
    cause: paymentCreationErrorCause(frozen.error.code),
  });
}

export const escrowPaymentProcedures = {
  createPaymentIntent: posterProcedure
    .input(
      z.object({
        taskId: Schemas.uuid,
        amount: z.number().int().positive().max(99999900).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requirePaymentCreation('escrow_funding');
      const taskRow = await db.query<{
        price: number | string | null;
        automation_classification: string | null;
      }>(
        `
        SELECT
          price,
          automation_classification
        FROM tasks
        WHERE id = $1
          AND poster_id = $2
        `,
        [input.taskId, ctx.user.id],
      );

      if (!taskRow.rows[0]) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      const taskPriceCents = canonicalPrice(taskRow.rows[0].price);

      if (taskPriceCents == null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Task price has not been set. Price the task before creating an escrow.',
        });
      }

      const amount = input.amount ?? taskPriceCents;

      if (!isExactCanonicalPaymentAmount(taskPriceCents, amount)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `Payment amount (${amount}) must exactly match task price (${taskPriceCents})`,
        });
      }

      const escrowRow = await db.query<{
        id: string;
        platform_fee_cents: number | string | null;
      }>(
        `
        SELECT
          id,
          platform_fee_cents
        FROM escrows
        WHERE task_id = $1
          AND state = 'PENDING'
          AND amount = $2
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [input.taskId, taskPriceCents],
      );

      if (!escrowRow.rows[0]) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'No pending escrow exactly matches the canonical task price',
        });
      }

      const escrowId = escrowRow.rows[0].id;
      const platformFeeCents = canonicalPrice(
        escrowRow.rows[0].platform_fee_cents,
      );

      const useLocalCertificationProvider =
        taskRow.rows[0].automation_classification === 'CONTROLLED_TEST'
        && localCertificationPaymentEnabled();

      const provider = resolvePaymentProvider(
        useLocalCertificationProvider ? 'local_test' : 'stripe',
      );

      const result = await provider.createPaymentIntent({
        taskId: input.taskId,
        posterId: ctx.user.id,
        escrowId,
        amountCents: amount,
        platformFeeCents,
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
        amountCents: result.data.amountCents,
      };
    }),

  confirmLocalTestPayment: posterProcedure
    .input(
      z
        .object({
          paymentIntentId: z.string().regex(/^pi_hxos_test_[a-f0-9]{32}$/),
          clientSecret: z.string().min(64).max(255),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      requirePaymentCreation('escrow_funding');
      const result = await LocalCertificationPaymentProvider.confirmIntent({
        paymentIntentId: input.paymentIntentId,
        clientSecret: input.clientSecret,
        posterId: ctx.user.id,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  confirmFunding: posterProcedure
    .input(Schemas.fundEscrow)
    .mutation(async ({ ctx, input }) => {
      const result = await EscrowService.getById(input.escrowId);

      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Escrow not found',
        });
      }

      if (result.data.poster_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the escrow creator can confirm funding',
        });
      }

      if (
        result.data.state === 'FUNDED'
        && result.data.stripe_payment_intent_id === input.stripePaymentIntentId
      ) {
        return result.data;
      }

      requirePaymentCreation('escrow_funding');

      const escrow = result.data as typeof result.data & {
        amount: number;
        task_id: string;
      };

      if (isLocalCertificationPaymentIntentId(input.stripePaymentIntentId)) {
        const verified =
          await LocalCertificationPaymentProvider.verifySucceededIntent({
            paymentIntentId: input.stripePaymentIntentId,
            escrowId: input.escrowId,
            taskId: escrow.task_id,
            posterId: ctx.user.id,
            amountCents: escrow.amount,
          });

        if (!verified.success) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: verified.error.message,
          });
        }
      } else {
        const providerName = isLocalCertificationPaymentIntentId(
          input.stripePaymentIntentId,
        )
          ? 'local_test'
          : 'stripe';

        const provider = resolvePaymentProvider(providerName);

        const verified = await provider.verifySucceededPayment({
          paymentIntentId: input.stripePaymentIntentId,
          escrowId: input.escrowId,
          taskId: escrow.task_id,
          posterId: ctx.user.id,
          amountCents: escrow.amount,
        });

        if (!verified.success) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: verified.error.message,
          });
        }
      }

      const duplicate = await db.query<{ id: string }>(
        `
        SELECT id
        FROM escrows
        WHERE stripe_payment_intent_id = $1
          AND id != $2
        `,
        [input.stripePaymentIntentId, input.escrowId],
      );

      if (duplicate.rows[0]) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Payment intent is already associated with another escrow',
        });
      }

      const funded = await EscrowService.fund({
        escrowId: input.escrowId,
        stripePaymentIntentId: input.stripePaymentIntentId,
      });

      if (!funded.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: funded.error.message,
        });
      }

      return funded.data;
    }),
};
