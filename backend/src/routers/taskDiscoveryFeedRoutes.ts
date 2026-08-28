import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hustlerProcedure, publicProcedure, Schemas } from '../trpc.js';
import { TaskDiscoveryService } from '../services/TaskDiscoveryService.js';
import { TaskSuggestionAIService } from '../services/TaskSuggestionAIService.js';
import { RecommendationService } from '../services/RecommendationService.js';
import { ControlledTestOfferReviewService } from '../services/ControlledTestOfferReviewService.js';
import { buildWorkerOfferDecision } from '../services/WorkerOfferDecisionPolicy.js';
import { canUserAcceptTask, getRequiredTierForTask } from './taskDiscoveryPolicy.js';

const browseInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(500).default(0),
  category: z.string().optional(),
  min_price: z.number().int().nonnegative().optional(),
  max_price: z.number().int().positive().optional(),
  sort_by: z.enum(['newest', 'price_high', 'price_low', 'deadline']).default('newest'),
});

const feedFilters = z.object({
  category: z.string().optional(),
  min_price: z.number().int().nonnegative().optional(),
  max_price: z.number().int().positive().optional(),
  max_distance_miles: z.number().positive().optional(),
  min_matching_score: z.number().min(0).max(1).optional(),
  sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
});

const feedInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(500).default(0),
  filters: feedFilters.optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  radiusMeters: z.number().positive().optional(),
  skills: z.array(z.string()).optional(),
});

function serviceFailure(message: string): never {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
}

function recommendationFailure(code: string, message: string): never {
  throw new TRPCError({
    code: code === 'RECOMMENDATION_NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
    message,
  });
}

function controlledOfferFailure(code: string, message: string): never {
  const trpcCode = code.includes('INVALID')
    ? 'BAD_REQUEST'
    : code.includes('IDEMPOTENCY_CONFLICT')
      ? 'CONFLICT'
      : code.includes('NOT_READY')
        ? 'PRECONDITION_FAILED'
        : code.includes('DISABLED')
          ? 'FORBIDDEN'
          : 'INTERNAL_SERVER_ERROR';
  throw new TRPCError({ code: trpcCode, message });
}

export const taskDiscoveryFeedProcedures = {
  reviewControlledTestOffer: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/),
    }).strict())
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await ControlledTestOfferReviewService.review({
        taskId: input.taskId,
        workerId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) return controlledOfferFailure(result.error.code, result.error.message);
      return result.data;
    }),

  acceptControlledTestOffer: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      offerDecisionId: Schemas.uuid,
      idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/),
    }).strict())
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await ControlledTestOfferReviewService.accept({
        taskId: input.taskId,
        offerDecisionId: input.offerDecisionId,
        workerId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) return controlledOfferFailure(result.error.code, result.error.message);
      return result.data;
    }),

  browseTasks: publicProcedure
    .input(browseInput)
    .query(async ({ input, ctx }) => {
      const userTrustTier = ctx.user?.trust_tier ?? 0;
      const result = await TaskDiscoveryService.browsePublicFeed(input, input.limit, input.offset);
      if (!result.success) return serviceFailure(result.error.message);
      const tasks = result.data.map((source) => {
        const defensiveSource = source as typeof source & { poster_id?: string };
        const { poster_id: _posterId, location: _storedLocation, ...publicTask } = defensiveSource;
        const task = { ...publicTask, location: source.rough_location ?? null };
        const offerDecision = buildWorkerOfferDecision({ ...task, distance_miles: null });
        const trustReady = canUserAcceptTask(userTrustTier, task.price);
        const requiredTrustTier = getRequiredTierForTask(task.price);
        return {
          ...task,
          offerDecision,
          canAccept: Boolean(ctx.user) && trustReady && offerDecision.decisionReady,
          requiredTrustTier,
          userTrustTier,
          verificationCTA: trustReady
            ? null
            : `Complete Level ${requiredTrustTier} verification to accept this task`,
          decisionCTA: offerDecision.decisionReady
            ? null
            : 'Open the personalized offer to verify payout, distance, duration, scope, terms, and ranking reasons before accepting.',
        };
      });
      return {
        tasks,
        totalAvailable: result.data.length,
        userTrustTier,
        isReadOnly: !ctx.user,
      };
    }),

  getFeed: hustlerProcedure
    .input(feedInput)
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const filters = {
        ...input.filters,
        ...(input.radiusMeters ? { max_distance_miles: input.radiusMeters / 1609.34 } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
      };
      const result = await TaskDiscoveryService.getFeed(
        ctx.user.id,
        filters,
        input.limit,
        input.offset,
      );
      if (!result.success) return serviceFailure(result.error.message);
      const userTrustTier = ctx.user.trust_tier ?? 0;
      return result.data.map((item) => {
        const task = item.task as typeof item.task & {
          worker_id?: string | null;
          poster_id?: string;
          location_lat?: number | null;
          location_lng?: number | null;
          location_geo?: unknown;
        };
        const isAssigned = task.worker_id === ctx.user!.id;
        const {
          poster_id: taskPosterId,
          location: _storedLocation,
          location_lat: _latitude,
          location_lng: _longitude,
          location_geo: _geography,
          ...taskWithoutPrivateLocation
        } = task;
        const taskWithoutPosterId = {
          ...taskWithoutPrivateLocation,
          location: task.rough_location ?? null,
        };
        const safeTask = isAssigned
          ? { ...taskWithoutPosterId, poster_id: taskPosterId }
          : taskWithoutPosterId;
        const trustReady = canUserAcceptTask(userTrustTier, item.task.price);
        const requiredTrustTier = getRequiredTierForTask(item.task.price);
        return {
          ...item,
          task: safeTask,
          offerDecision: item.offer_decision,
          canAccept: trustReady && item.offer_decision.decisionReady,
          requiredTrustTier,
          verificationCTA: trustReady
            ? null
            : `Complete Level ${requiredTrustTier} verification to accept this task`,
          decisionCTA: item.offer_decision.decisionReady
            ? null
            : 'This offer is not accept-ready until every economic, logistics, scope, terms, and ranking field is verified.',
        };
      });
    }),

  calculateFeedScores: hustlerProcedure
    .input(z.object({ maxDistanceMiles: z.number().positive().default(10) }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await TaskDiscoveryService.calculateFeedScores(
        ctx.user.id,
        input.maxDistanceMiles,
      );
      if (!result.success) return serviceFailure(result.error.message);
      return result.data;
    }),

  calculateMatchingScore: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await TaskDiscoveryService.calculateMatchingScore(input.taskId, ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  getExplanation: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await TaskDiscoveryService.getExplanation(input.taskId, ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return { explanation: result.data };
    }),

  getAISuggestions: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(20).default(10),
      max_distance_miles: z.number().positive().optional(),
      category: z.string().optional(),
      min_price: z.number().int().nonnegative().optional(),
      max_price: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await TaskSuggestionAIService.getSuggestions(ctx.user.id, {
        limit: input?.limit,
        max_distance_miles: input?.max_distance_miles,
        category: input?.category,
        min_price: input?.min_price,
        max_price: input?.max_price,
      });
      if (!result.success) return serviceFailure(result.error.message);
      return {
        suggestions: result.data.map((suggestion) => ({
          ...suggestion,
          offerDecision: suggestion.offerDecision,
        })),
      };
    }),

  listRecommendations: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).max(500).default(0),
    }).strict())
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await RecommendationService.listCurrent(ctx.user.id, input);
      if (!result.success) return serviceFailure(result.error.message);
      return result.data;
    }),

  recordRecommendationAction: hustlerProcedure
    .input(z.object({
      recommendationId: Schemas.uuid,
      action: z.enum(['OPENED', 'EDITED', 'DISMISSED', 'SNOOZED', 'IGNORED', 'OVERRIDDEN', 'APPEALED']),
      idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/),
      publicNote: z.string().trim().min(1).max(1000).optional(),
    }).strict())
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await RecommendationService.recordUserEvent({
        actorId: ctx.user.id,
        recommendationId: input.recommendationId,
        eventType: input.action,
        idempotencyKey: input.idempotencyKey,
        publicNote: input.publicNote ?? null,
      });
      if (!result.success) return recommendationFailure(result.error.code, result.error.message);
      return result.data;
    }),
};
