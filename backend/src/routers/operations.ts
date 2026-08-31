import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { operationsAdminProcedure, router } from '../trpc.js';
import { AIObservabilityService } from '../services/AIObservabilityService.js';
import {
  OperationsExceptionService,
  operationsPriorityClasses,
} from '../services/OperationsExceptionService.js';
import {
  UniversalV1OpsCaseService,
  universalV1OpsCaseCategories,
  universalV1OpsCaseSeverities,
  universalV1OpsCaseStatuses,
  universalV1OpsCaseTransitionKinds,
} from '../services/UniversalV1OpsCaseService.js';

const clusterKey = z.string().min(3).max(240);
const idempotencyKey = z.string().uuid();
const exactVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const evidenceDigest = z.string().regex(/^[a-f0-9]{64}$/);
const opsCaseReason = z.string().trim().min(10).max(500);

export const operationsRouter = router({
  listAIActivity: operationsAdminProcedure
    .input(
      z.object({
        surfaceId: z.string().trim().min(3).max(100).optional(),
        executionResult: z.enum(['GENERATED', 'CACHED', 'FAILED']).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(10_000).default(0),
      })
    )
    .query(({ input }) => AIObservabilityService.list(input)),

  getAIObservationDetail: operationsAdminProcedure
    .input(
      z.object({
        observationId: z.string().uuid(),
        purpose: z.string().trim().min(10).max(500),
      })
    )
    .query(async ({ ctx, input }) => {
      const detail = await AIObservabilityService.getDetail(
        input.observationId,
        input.purpose,
        ctx.user.id
      );
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'AI observation not found.' });
      return detail;
    }),

  listExceptions: operationsAdminProcedure
    .input(
      z.object({
        priorityClass: z.enum(operationsPriorityClasses).optional(),
        ownership: z.enum(['ALL', 'MINE', 'UNASSIGNED']).default('ALL'),
        search: z.string().trim().min(2).max(100).optional(),
        sort: z.enum(['PRIORITY', 'OLDEST', 'NEWEST', 'SIGNAL_COUNT']).default('PRIORITY'),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(10_000).default(0),
      })
    )
    .query(({ ctx, input }) => OperationsExceptionService.list(input, ctx.user.id)),

  getExceptionDetail: operationsAdminProcedure
    .input(
      z.object({
        clusterKey,
        purpose: z.string().trim().min(10).max(500),
      })
    )
    .query(({ ctx, input }) =>
      OperationsExceptionService.getDetail(input.clusterKey, input.purpose, ctx.user.id)
    ),

  getModelHealth: operationsAdminProcedure
    .input(z.object({}))
    .query(() => OperationsExceptionService.getModelHealth()),

  claimException: operationsAdminProcedure
    .input(z.object({ clusterKey, idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.claim(input, ctx.user.id)),

  releaseException: operationsAdminProcedure
    .input(z.object({ clusterKey, idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.release(input, ctx.user.id)),

  scheduleNotificationRecovery: operationsAdminProcedure
    .input(z.object({ clusterKey, deliveryId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) =>
      OperationsExceptionService.scheduleNotificationRecovery(input, ctx.user.id)
    ),

  cancelNotificationRecovery: operationsAdminProcedure
    .input(z.object({ clusterKey, actionEventId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) =>
      OperationsExceptionService.cancelNotificationRecovery(input, ctx.user.id)
    ),

  listUniversalV1Cases: operationsAdminProcedure
    .input(
      z
        .object({
          status: z.enum(universalV1OpsCaseStatuses).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).max(10_000).default(0),
        })
        .strict()
    )
    .query(({ ctx, input }) => UniversalV1OpsCaseService.list(ctx, input)),

  getUniversalV1Case: operationsAdminProcedure
    .input(
      z
        .object({
          caseId: z.string().uuid(),
          purpose: opsCaseReason,
        })
        .strict()
    )
    .query(({ ctx, input }) => UniversalV1OpsCaseService.get(ctx, input)),

  openUniversalV1Case: operationsAdminProcedure
    .input(
      z
        .object({
          occurrenceId: z.string().uuid(),
          occurrenceEventName: z.string().regex(/^[a-z][a-z0-9_.-]{2,119}$/),
          occurrenceVersion: exactVersion,
          aggregateKind: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
          aggregateId: z.string().regex(/^[A-Za-z0-9:_-]{2,200}$/),
          aggregateVersion: exactVersion,
          category: z.enum(universalV1OpsCaseCategories),
          severity: z.enum(universalV1OpsCaseSeverities),
          reason: opsCaseReason,
          evidenceDigest,
          idempotencyKey,
        })
        .strict()
    )
    .mutation(({ ctx, input }) => UniversalV1OpsCaseService.open(ctx, input)),

  acknowledgeUniversalV1Case: operationsAdminProcedure
    .input(
      z
        .object({
          caseId: z.string().uuid(),
          expectedVersion: exactVersion,
          reason: opsCaseReason,
          evidenceDigest,
          idempotencyKey,
        })
        .strict()
    )
    .mutation(({ ctx, input }) => UniversalV1OpsCaseService.acknowledge(ctx, input)),

  requestUniversalV1CaseTransition: operationsAdminProcedure
    .input(
      z
        .object({
          caseId: z.string().uuid(),
          expectedCaseVersion: exactVersion,
          transitionKind: z.enum(universalV1OpsCaseTransitionKinds),
          reason: opsCaseReason,
          evidenceDigest,
          idempotencyKey,
        })
        .strict()
    )
    .mutation(({ ctx, input }) => UniversalV1OpsCaseService.requestTransition(ctx, input)),

  decideUniversalV1CaseTransition: operationsAdminProcedure
    .input(
      z
        .object({
          transitionRequestId: z.string().uuid(),
          expectedRequestVersion: exactVersion,
          expectedCaseVersion: exactVersion,
          decision: z.enum(['APPROVE', 'REJECT']),
          reason: opsCaseReason,
          evidenceDigest,
          idempotencyKey,
        })
        .strict()
    )
    .mutation(({ ctx, input }) => UniversalV1OpsCaseService.decideTransition(ctx, input)),
});

export default operationsRouter;
