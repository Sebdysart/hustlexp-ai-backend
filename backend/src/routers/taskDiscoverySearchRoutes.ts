import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hustlerProcedure, Schemas } from '../trpc.js';
import { TaskDiscoveryService } from '../services/TaskDiscoveryService.js';

const searchFilters = z.object({
  category: z.string().optional(),
  min_price: z.number().int().nonnegative().optional(),
  max_price: z.number().int().positive().optional(),
  max_distance_miles: z.number().positive().optional(),
  min_matching_score: z.number().min(0).max(1).optional(),
  sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
});

function authenticatedUserId(ctx: { user?: { id: string } | null }): string {
  if (ctx.user) return ctx.user.id;
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
}

function serviceFailure(message: string, notFound = false): never {
  throw new TRPCError({
    code: notFound ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
    message,
  });
}

export const taskDiscoverySearchProcedures = {
  search: hustlerProcedure
    .input(z.object({
      query: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(500).default(0),
      filters: searchFilters.optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      category: z.string().optional(),
      minPaymentCents: z.number().int().nonnegative().optional(),
      maxPaymentCents: z.number().int().positive().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const userId = authenticatedUserId(ctx);
      const filters: Record<string, unknown> = {
        ...input.filters,
        query: input.query,
        ...(input.category && !input.filters?.category ? { category: input.category } : {}),
        ...(input.minPaymentCents && !input.filters?.min_price
          ? { min_price: input.minPaymentCents }
          : {}),
        ...(input.maxPaymentCents && !input.filters?.max_price
          ? { max_price: input.maxPaymentCents }
          : {}),
      };
      const result = await TaskDiscoveryService.search(
        userId,
        filters,
        input.limit,
        input.offset,
      );
      if (!result.success) return serviceFailure(result.error.message);
      return result.data;
    }),

  saveSearch: hustlerProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      query: z.string().max(200).optional(),
      filters: z.record(z.any()).optional().default({}),
      sortBy: z.enum(['relevance', 'price', 'distance', 'deadline']).default('relevance'),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = authenticatedUserId(ctx);
      const result = await TaskDiscoveryService.saveSearch(
        userId,
        input.name,
        input.query,
        input.filters || {},
        input.sortBy,
      );
      if (!result.success) {
        return serviceFailure(result.error.message, result.error.code === 'NOT_FOUND');
      }
      return result.data;
    }),

  getSavedSearches: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await TaskDiscoveryService.getSavedSearches(authenticatedUserId(ctx));
      if (!result.success) return serviceFailure(result.error.message);
      return result.data;
    }),

  deleteSavedSearch: hustlerProcedure
    .input(z.object({ searchId: Schemas.uuid }))
    .mutation(async ({ input, ctx }) => {
      const result = await TaskDiscoveryService.deleteSavedSearch(
        input.searchId,
        authenticatedUserId(ctx),
      );
      if (!result.success) {
        return serviceFailure(result.error.message, result.error.code === 'NOT_FOUND');
      }
      return { success: true };
    }),

  executeSavedSearch: hustlerProcedure
    .input(z.object({
      searchId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(500).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const result = await TaskDiscoveryService.executeSavedSearch(
        input.searchId,
        authenticatedUserId(ctx),
        input.limit,
        input.offset,
      );
      if (!result.success) {
        return serviceFailure(result.error.message, result.error.code === 'NOT_FOUND');
      }
      return result.data;
    }),
};
