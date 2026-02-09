/**
 * Task Discovery Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §9, TASK_DISCOVERY_SPEC.md
 * 
 * Endpoints for task discovery, matching, filtering, sorting, and search.
 * 
 * @see backend/src/services/TaskDiscoveryService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc';
import { TaskDiscoveryService } from '../services/TaskDiscoveryService';

export const taskDiscoveryRouter = router({
  // --------------------------------------------------------------------------
  // TASK FEED (Matching & Relevance)
  // --------------------------------------------------------------------------
  
  /**
   * Get task feed with matching scores (for hustler feed)
   * 
   * PRODUCT_SPEC §9: Task Discovery & Matching Algorithm
   */
  getFeed: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      // Structured filters (original)
      filters: z.object({
        category: z.string().optional(),
        min_price: z.number().int().nonnegative().optional(),
        max_price: z.number().int().positive().optional(),
        max_distance_miles: z.number().positive().optional(),
        min_matching_score: z.number().min(0).max(1).optional(),
        sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
      }).optional(),
      // Flat params from iOS frontend (merged into filters)
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      radiusMeters: z.number().positive().optional(),
      skills: z.array(z.string()).optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      // Merge flat iOS params into filters object
      const filters = {
        ...input.filters,
        ...(input.radiusMeters ? { max_distance_miles: input.radiusMeters / 1609.34 } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
      };

      const result = await TaskDiscoveryService.getFeed(
        ctx.user.id,
        filters,
        input.limit,
        input.offset
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Calculate matching scores for feed (batch calculation)
   * 
   * Call this periodically to pre-calculate scores for better feed performance
   */
  calculateFeedScores: protectedProcedure
    .input(z.object({
      maxDistanceMiles: z.number().positive().default(10.0),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.calculateFeedScores(
        ctx.user.id,
        input.maxDistanceMiles
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Calculate matching score for a specific task
   */
  calculateMatchingScore: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.calculateMatchingScore(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get "Why this task?" explanation for a task
   * 
   * PRODUCT_SPEC §9.4: Explains why a task matches the hustler
   */
  getExplanation: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.getExplanation(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return {
        explanation: result.data,
      };
    }),
  
  // --------------------------------------------------------------------------
  // SEARCH
  // --------------------------------------------------------------------------
  
  /**
   * Search tasks by query (full-text search)
   */
  search: protectedProcedure
    .input(z.object({
      query: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      filters: z.object({
        category: z.string().optional(),
        min_price: z.number().int().nonnegative().optional(),
        max_price: z.number().int().positive().optional(),
        max_distance_miles: z.number().positive().optional(),
        min_matching_score: z.number().min(0).max(1).optional(),
        sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
      }).optional(),
      // Flat params from iOS frontend (merged into filters)
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      category: z.string().optional(),
      minPaymentCents: z.number().int().nonnegative().optional(),
      maxPaymentCents: z.number().int().positive().optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const searchFilters: any = {
        ...input.filters,
        query: input.query,
        // Merge flat iOS params
        ...(input.category && !input.filters?.category ? { category: input.category } : {}),
        ...(input.minPaymentCents && !input.filters?.min_price ? { min_price: input.minPaymentCents } : {}),
        ...(input.maxPaymentCents && !input.filters?.max_price ? { max_price: input.maxPaymentCents } : {}),
      };
      
      const result = await TaskDiscoveryService.search(
        ctx.user.id,
        searchFilters,
        input.limit,
        input.offset
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // SAVED SEARCHES (PRODUCT_SPEC §9.4)
  // --------------------------------------------------------------------------
  
  /**
   * Save a search query for quick access
   */
  saveSearch: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      query: z.string().max(200).optional(),
      filters: z.record(z.any()).optional().default({}),
      sortBy: z.enum(['relevance', 'price', 'distance', 'deadline']).default('relevance'),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.saveSearch(
        ctx.user.id,
        input.name,
        input.query,
        input.filters || {},
        input.sortBy
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get all saved searches for the authenticated user
   */
  getSavedSearches: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.getSavedSearches(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Delete a saved search
   */
  deleteSavedSearch: protectedProcedure
    .input(z.object({
      searchId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.deleteSavedSearch(
        input.searchId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return { success: true };
    }),
  
  /**
   * Execute a saved search (run search with saved filters)
   */
  executeSavedSearch: protectedProcedure
    .input(z.object({
      searchId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.executeSavedSearch(
        input.searchId,
        ctx.user.id,
        input.limit,
        input.offset
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
