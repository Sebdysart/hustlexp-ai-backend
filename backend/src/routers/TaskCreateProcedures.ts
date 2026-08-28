import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { ScoperAIService } from '../services/ScoperAIService.js';
import { AIObservabilityService } from '../services/AIObservabilityService.js';
import { TaskLocationService } from '../services/TaskLocationService.js';
import { assertImplementedFields } from '../services/TaskCreationPolicy.js';
import { TaskService } from '../services/TaskService.js';
import type { CreateTaskParams } from '../services/TaskServiceShared.js';
import { getTemplate } from '../services/TaskTemplateRegistry.js';
import { hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import type { AuthedContext } from '../trpc-context.js';
import type { Task } from '../types.js';
import { checkDraftEvalRateLimit, checkTaskCreateRateLimit } from './task-router-common.js';

type CreateInput = z.infer<typeof Schemas.createTask>;

function hasUnsupportedLocationCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertQuoteEconomics(input: CreateInput, ctx: AuthedContext): void {
  const hasPayout = input.hustlerPayoutCents !== undefined;
  const hasMargin = input.platformMarginCents !== undefined;
  if (hasPayout !== hasMargin) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Quoted payout and margin must be provided together.' });
  }
  if (!hasPayout) return;
  if (ctx.engineBridgeAuthorized !== true) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Canonical quote economics require engine bridge authority.' });
  }
  if (input.hustlerPayoutCents! + input.platformMarginCents! !== input.price) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Quoted payout and margin must reconcile to the task price.' });
  }
}

function createParams(
  input: CreateInput,
  ctx: AuthedContext,
  templateSlug: string,
  compliance?: Awaited<ReturnType<typeof ComplianceGuardianService.evaluate>>,
): CreateTaskParams {
  if (input.isTest === true && ctx.engineBridgeAuthorized !== true) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Controlled-test provenance requires engine bridge authority.' });
  }
  return {
    posterId: ctx.user.id,
    title: input.title,
    description: input.description,
    price: input.price,
    hustlerPayoutCents: input.hustlerPayoutCents,
    platformMarginCents: input.platformMarginCents,
    requirements: input.requirements,
    location: input.location,
    regionCode: input.regionCode,
    category: input.category,
    deadline: input.deadline ? new Date(input.deadline) : undefined,
    dispatchExpiresAt: input.dispatchExpiresAt ? new Date(input.dispatchExpiresAt) : undefined,
    requiresProof: input.requiresProof,
    mode: input.mode,
    liveBroadcastRadiusMiles: input.liveBroadcastRadiusMiles,
    instantMode: input.instantMode,
    templateSlug,
    wildcardFlags: input.wildcardFlags,
    insideHome: input.insideHome,
    peoplePresent: input.peoplePresent,
    petsPresent: input.petsPresent,
    complianceAiSignalsComputed: compliance?.ai_signals_computed,
    complianceDeceptionDetected: compliance?.deception_detected,
    complianceGenuinelyBizarre: compliance?.is_genuinely_bizarre,
    illegalRiskScore: compliance?.score,
    complianceGuardianNotes: compliance?.notes,
    clientIdempotencyKey: input.clientIdempotencyKey,
    roughArea: input.roughArea,
    automationClassification: input.isTest === true ? 'CONTROLLED_TEST' : 'PRODUCTION',
    proofSteps: input.proof_steps?.map(({ step }) => step),
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    requiredTools: input.requiredTools,
    aiScopeObservationId: input.aiScopeObservationId,
  };
}

async function preflightReplay(params: CreateTaskParams): Promise<Task | undefined> {
  if (!params.clientIdempotencyKey) return undefined;
  const result = await TaskService.lookupCreateRequest(params);
  if (!result.success) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
  if (result.data.status === 'replay') return { ...result.data.task, idempotency_replayed: true };
  if (result.data.status === 'conflict') {
    throw new TRPCError({ code: 'CONFLICT', message: 'Idempotency key was already used with different task input.' });
  }
  return undefined;
}

async function assertCompliance(input: CreateInput, userId: string) {
  const result = await ComplianceGuardianService.evaluate({
    description: input.description,
    userId,
    templateSlug: input.templateSlug,
  });
  if (result.tier === 'hard_block') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Task blocked by compliance check. HustleXP only allows legal IRL tasks.',
    });
  }
  return result;
}

function requiredTemplate(templateSlug: string) {
  const template = getTemplate(templateSlug);
  if (!template) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid template: ${templateSlug}. Use GET /api/templates/manifest for valid options.`,
    });
  }
  return template;
}

function unwrapCreated(result: Awaited<ReturnType<typeof TaskService.create>>): Task {
  if (result.success) return result.data;
  let code: 'BAD_REQUEST' | 'PRECONDITION_FAILED' | 'CONFLICT' = 'BAD_REQUEST';
  if (result.error.code === 'HX902' || result.error.code === 'HX901') code = 'PRECONDITION_FAILED';
  if (result.error.code === 'IDEMPOTENCY_CONFLICT') code = 'CONFLICT';
  throw new TRPCError({ code, message: result.error.message });
}

async function handleCreateTask({ ctx, input }: { ctx: AuthedContext; input: CreateInput }): Promise<Task> {
  assertImplementedFields(input);
  assertQuoteEconomics(input, ctx);
  const templateSlug = input.templateSlug ?? 'standard_physical';
  requiredTemplate(templateSlug);
  const replay = await preflightReplay(createParams(input, ctx, templateSlug));
  if (replay) return replay;
  await checkTaskCreateRateLimit(ctx.user.id);
  const compliance = await assertCompliance(input, ctx.user.id);
  const params = createParams(input, ctx, templateSlug, compliance);
  const task = unwrapCreated(await TaskService.create(params));
  await invalidateTask(task.id);
  return task;
}

export const TaskCreateProcedures = {
create: posterProcedure
    .input(Schemas.createTask)
    .mutation(handleCreateTask),
setExactLocation: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      exactLocation: z.string().trim().min(5).max(500).refine(
        (value) => !hasUnsupportedLocationCharacter(value),
        'Service location contains unsupported characters.',
      ),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskLocationService.setByPoster({
        taskId: input.taskId,
        posterId: ctx.user.id,
        exactLocation: input.exactLocation,
      });
      if (!result.success) {
        const code = result.error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : result.error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : result.error.code === 'DB_ERROR'
              ? 'INTERNAL_SERVER_ERROR'
              : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: result.error.message });
      }
      return result.data;
    }),
releaseExactLocation: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskLocationService.releaseToReservedWorker({
        taskId: input.taskId,
        workerId: ctx.user.id,
      });
      if (!result.success) {
        const code = result.error.code === 'NOT_FOUND' || result.error.code === 'EXACT_LOCATION_MISSING'
          ? 'NOT_FOUND'
          : result.error.code === 'DB_ERROR'
            ? 'INTERNAL_SERVER_ERROR'
            : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: result.error.message });
      }
      return result.data;
    }),
evaluateDraft: posterProcedure
    .input(Schemas.evaluateDraft)
    .mutation(async ({ ctx, input }) => {
      await checkDraftEvalRateLimit(ctx.user.id);

      const complianceResult = await ComplianceGuardianService.evaluate({
        description: input.description,
        userId: ctx.user.id,
        templateSlug: input.templateSlug,
      });

      if (complianceResult.tier === 'hard_block') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This task was blocked. Reason: ${complianceResult.triggeredRules.join(', ')}. HustleXP only allows legal IRL tasks.`,
        });
      }

      const scopeResult = await ScoperAIService.analyzeTaskScope({
        userId: ctx.user.id,
        description: input.description,
        templateSlug: input.templateSlug,
        wildcardFlags: input.wildcardFlags,
        complianceResult: complianceResult,
      });

      return {
        score: complianceResult.score,
        tier: complianceResult.tier,
        triggeredRules: complianceResult.triggeredRules,
        suggestedAlternative: complianceResult.suggestedAlternative,
        notes: complianceResult.notes,
        scopeProposal: scopeResult.success ? scopeResult.data : null,
      };
    }),
respondToScopeProposal: posterProcedure
    .input(z.object({
      observationId: Schemas.uuid,
      action: z.enum(['ACCEPTED', 'EDITED', 'DISMISSED', 'SNOOZED', 'OVERRIDDEN']),
      editedFields: z.array(z.string().trim().min(1).max(100)).max(24).default([]),
      idempotencyKey: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await AIObservabilityService.recordUserResponse({
        observationId: input.observationId,
        actorUserId: ctx.user.id,
        action: input.action,
        editedFields: input.editedFields,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) {
        const code = result.error.code === 'AI_OBSERVATION_NOT_FOUND'
          ? 'NOT_FOUND'
          : result.error.code === 'IDEMPOTENCY_CONFLICT'
            ? 'CONFLICT'
            : 'INTERNAL_SERVER_ERROR';
        throw new TRPCError({ code, message: result.error.message });
      }
      return result.data;
    })
};
