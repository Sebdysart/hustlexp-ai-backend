import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { adminOrEngineBridgeProcedure, platformAdminProcedure, router, Schemas } from '../trpc.js';
import { AutomationLifecycleService } from '../services/AutomationLifecycleService.js';
import { VerifiedPosterCompletionService } from '../services/VerifiedPosterCompletionService.js';
import { VerifiedPosterRatingService } from '../services/VerifiedPosterRatingService.js';
import { TaskService } from '../services/TaskService.js';
import { HustlerIdentityLinkService } from '../services/HustlerIdentityLinkService.js';
import { EscrowService } from '../services/EscrowService.js';
import { LocalCertificationPayoutProvider } from '../services/LocalCertificationPayoutProvider.js';
import { LocalCertificationScreeningProvider } from '../services/LocalCertificationScreeningProvider.js';
import { ControlledTestLiquidityService } from '../services/ControlledTestLiquidityService.js';
import { ControlledTestDurationEvidenceService } from '../services/ControlledTestDurationEvidenceService.js';
import { ControlledTestProviderCapabilityService } from '../services/ControlledTestProviderCapabilityService.js';
import { notifyPaymentReleased } from '../lib/task-lifecycle-notifications.js';
import { ErrorCodes } from '../types.js';

const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

function throwServiceError(error: { code: string; message: string }): never {
  const code = error.code === 'NOT_FOUND'
    ? 'NOT_FOUND'
    : error.code === 'IDEMPOTENCY_CONFLICT'
      ? 'CONFLICT'
      : error.code === 'DB_ERROR'
        ? 'INTERNAL_SERVER_ERROR'
        : error.code === 'INVALID_CURSOR'
          ? 'BAD_REQUEST'
          : 'PRECONDITION_FAILED';
  throw new TRPCError({ code, message: error.message });
}

/** Admin-gated engine lifecycle and automation scheduler contracts. */
export const automationRouter = router({
  applyControlledTestDurationEvidence: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      sourceQuoteVersionId: Schemas.uuid,
      minimumMinutes: z.number().int().min(15).max(1440),
      expectedMinutes: z.number().int().min(15).max(1440),
      maximumMinutes: z.number().int().min(15).max(1440),
      policyVersion: z.literal('price-book-duration-v1'),
      sourceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      sourceEnvironment: z.literal('TEST'),
      idempotencyKey,
    }).superRefine((value, context) => {
      if (value.minimumMinutes > value.expectedMinutes || value.expectedMinutes > value.maximumMinutes) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duration estimate must remain inside its range.' });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ControlledTestDurationEvidenceService.apply({
        taskId: input.engineTaskId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        sourceQuoteVersionId: input.sourceQuoteVersionId,
        minimumMinutes: input.minimumMinutes,
        expectedMinutes: input.expectedMinutes,
        maximumMinutes: input.maximumMinutes,
        policyVersion: input.policyVersion,
        sourceEvidenceHash: input.sourceEvidenceHash,
        sourceEnvironment: input.sourceEnvironment,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  recordControlledTestProviderCapability: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      workerId: Schemas.uuid,
      sourceHustlerId: Schemas.uuid,
      category: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
      tools: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
      serviceCity: z.string().trim().min(2).max(100),
      serviceState: z.string().regex(/^[A-Z]{2}$/),
      serviceRadiusMiles: z.number().int().min(1).max(100),
      sourcePolicyVersion: z.string().trim().min(1).max(100),
      sourceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      sourceExpiresAt: z.string().datetime({ offset: true }),
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ControlledTestProviderCapabilityService.record({
        taskId: input.engineTaskId,
        workerId: input.workerId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        sourceHustlerId: input.sourceHustlerId,
        category: input.category,
        tools: input.tools,
        serviceCity: input.serviceCity,
        serviceState: input.serviceState,
        serviceRadiusMiles: input.serviceRadiusMiles,
        sourcePolicyVersion: input.sourcePolicyVersion,
        sourceEvidenceHash: input.sourceEvidenceHash,
        sourceExpiresAt: input.sourceExpiresAt,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  linkHustlerIdentity: adminOrEngineBridgeProcedure
    .input(z.object({
      engineHustlerRef: Schemas.uuid,
      phoneE164: z.string().regex(/^\+1[2-9][0-9]{9}$/),
      providerClaimId: Schemas.uuid,
    }))
    .mutation(async ({ input }) => {
      const result = await HustlerIdentityLinkService.link(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  completeLocalTestScreening: adminOrEngineBridgeProcedure
    .input(z.object({
      backgroundCheckId: Schemas.uuid,
      workerId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await LocalCertificationScreeningProvider.completeClear({
        backgroundCheckId: input.backgroundCheckId,
        workerId: input.workerId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  prepareLocalTestLiquidity: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      workerId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ControlledTestLiquidityService.prepareAndBind({
        taskId: input.engineTaskId,
        workerId: input.workerId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  settleLocalTestPayout: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ input }) => {
      const context = await db.query<{
        task_id: string;
        worker_id: string | null;
        automation_classification: string | null;
        escrow_id: string;
      }>(
        `SELECT t.id AS task_id, t.worker_id, t.automation_classification,
                e.id AS escrow_id
         FROM tasks t
         JOIN escrows e ON e.task_id = t.id
         WHERE t.id = $1
         ORDER BY e.created_at DESC
         LIMIT 1`,
        [input.engineTaskId],
      );
      const row = context.rows[0];
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task payout context not found' });
      if (row.automation_classification !== 'CONTROLLED_TEST' || !row.worker_id) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Local TEST settlement requires an assigned CONTROLLED_TEST task',
        });
      }
      const transfer = await LocalCertificationPayoutProvider.createPaidTransfer({
        taskId: row.task_id,
        escrowId: row.escrow_id,
        workerId: row.worker_id,
        idempotencyKey: input.idempotencyKey,
      });
      if (!transfer.success) throwServiceError(transfer.error);

      const released = await EscrowService.release({
        escrowId: row.escrow_id,
        localTestTransferId: transfer.data.transferId,
      });
      if (!released.success) {
        if (released.error.code !== ErrorCodes.ESCROW_TERMINAL
            && released.error.code !== ErrorCodes.INVALID_STATE) {
          throwServiceError(released.error);
        }
        const converged = await db.query<{
          state: string;
          payout_provider: string | null;
          provider_transfer_id: string | null;
          provider_transfer_status: string | null;
        }>(
          `SELECT state, payout_provider, provider_transfer_id,
                  provider_transfer_status
           FROM escrows WHERE id = $1`,
          [row.escrow_id],
        );
        if (
          converged.rows[0]?.state !== 'RELEASED'
          || converged.rows[0]?.payout_provider !== 'LOCAL_CERTIFICATION_TEST'
          || converged.rows[0]?.provider_transfer_id !== transfer.data.transferId
          || converged.rows[0]?.provider_transfer_status !== 'paid'
        ) {
          throwServiceError(released.error);
        }
      }
      // NotificationService derives a stable task/category dedupe key. Calling
      // after every exact convergence makes a crash-replay repair a missing
      // update without ever creating a second visible payout notification.
      await notifyPaymentReleased(row.worker_id, row.task_id, transfer.data.amountCents);
      return {
        engineTaskId: row.task_id,
        escrowId: row.escrow_id,
        transferId: transfer.data.transferId,
        provider: transfer.data.provider,
        providerStatus: transfer.data.status,
        amountCents: transfer.data.amountCents,
        escrowState: 'RELEASED' as const,
        isTest: true as const,
        idempotencyReplayed: transfer.data.idempotencyReplayed,
      };
    }),

  listTasks: platformAdminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().max(512).nullish(),
    }))
    .query(async ({ input }) => {
      const result = await AutomationLifecycleService.listTasks(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  getBridgeTaskState: adminOrEngineBridgeProcedure
    .input(z.object({ engineTaskId: Schemas.uuid }))
    .query(async ({ input }) => {
      const result = await AutomationLifecycleService.getBridgeTaskState(input.engineTaskId);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  expireUnfilled: platformAdminProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ input }) => {
      const result = await AutomationLifecycleService.expireUnfilled(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  expireDue: platformAdminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .mutation(async ({ input }) => {
      const result = await AutomationLifecycleService.expireDue(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  recordCompletionDelivery: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      providerDeliveryId: z.string().trim().min(4).max(255),
      channel: z.enum(['SMS', 'EMAIL', 'PUSH']),
      deliveredAt: z.string().datetime(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.recordCompletionDelivery({
        taskId: input.engineTaskId,
        providerDeliveryId: input.providerDeliveryId,
        channel: input.channel,
        deliveredAt: new Date(input.deliveredAt),
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  completeUnattended: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.complete(input.engineTaskId, undefined, {
        mode: 'UNATTENDED',
        idempotencyKey: input.idempotencyKey,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        lifecycleState: 'PAYOUT_READY' as const,
        payoutState: 'READY' as const,
        idempotencyReplayed: result.data.completion_idempotency_replayed === true,
      };
    }),

  confirmPosterCompletion: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      providerConfirmationId: z.string().trim().min(8).max(255).regex(/^[A-Za-z0-9:_-]+$/),
      score: z.union([z.literal(4), z.literal(5)]),
    }))
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.user?.id ?? ctx.engineBridgeActorId!;
      const result = await VerifiedPosterCompletionService.confirm({
        taskId: input.engineTaskId,
        providerConfirmationId: input.providerConfirmationId,
        score: input.score,
        actorId,
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        lifecycleState: 'PAYOUT_READY' as const,
        payoutState: 'READY' as const,
        idempotencyReplayed: result.data.completion_idempotency_replayed === true,
      };
    }),

  markWorkerTraveling: adminOrEngineBridgeProcedure
    .input(z.object({ engineTaskId: Schemas.uuid }))
    .mutation(async ({ input }) => {
      const task = await TaskService.getById(input.engineTaskId);
      if (!task.success) throwServiceError(task.error);
      if (!task.data.worker_id) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task has no engine-reserved hustler' });
      }
      const result = await TaskService.advanceProgress({
        taskId: input.engineTaskId,
        to: 'TRAVELING',
        actor: { type: 'worker', userId: task.data.worker_id },
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        progressState: 'TRAVELING' as const,
      };
    }),

  submitPosterRating: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      providerReviewId: z.string().trim().min(8).max(255).regex(/^[A-Za-z0-9:_-]+$/),
      score: z.number().int().min(1).max(5),
    }))
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.user?.id ?? ctx.engineBridgeActorId!;
      const result = await VerifiedPosterRatingService.record({
        taskId: input.engineTaskId,
        providerReviewId: input.providerReviewId,
        score: input.score as 1 | 2 | 3 | 4 | 5,
        actorId,
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.taskId,
        ratingId: result.data.ratingId,
        score: result.data.score,
        idempotencyReplayed: result.data.idempotencyReplayed,
      };
    }),
});

export type AutomationRouter = typeof automationRouter;
