/**
 * GDPR Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §16, GDPR_COMPLIANCE_SPEC.md
 * 
 * Endpoints for GDPR compliance (data export, deletion, consent management).
 * 
 * @see backend/src/services/GDPRService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc.js';
import { GDPRService } from '../services/GDPRService.js';

export const gdprRouter = router({
  // --------------------------------------------------------------------------
  // DATA EXPORT (GDPR Export Request)
  // --------------------------------------------------------------------------
  
  /**
   * Create GDPR request (export, deletion, rectification, restriction)
   * 
   * PRODUCT_SPEC §16: GDPR Compliance
   * GDPR-1: Data export requests processed within 30 days
   * GDPR-2: Data deletion requests processed within 7 days
   */
  createRequest: protectedProcedure
    .input(z.object({
      requestType: z.enum(['export', 'deletion', 'rectification', 'restriction']),
      exportFormat: z.enum(['json', 'csv', 'pdf']).optional(), // Required for 'export'
      scope: z.array(z.string().max(50)).max(20).optional(), // Optional: specific data categories for export
      requestDetails: z.record(z.any()).optional(), // Optional JSONB details
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Validate export format for export requests
      if (input.requestType === 'export' && !input.exportFormat) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Export format is required for export requests',
        });
      }
      
      const result = await GDPRService.createRequest({
        userId: ctx.user.id,
        requestType: input.requestType,
        exportFormat: input.exportFormat,
        scope: input.scope,
        requestDetails: input.requestDetails,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'BAD_REQUEST'
            ? result.error.code
            : result.error.code === 'INVALID_STATE'
            ? 'BAD_REQUEST'
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get status of GDPR request
   */
  getRequestStatus: protectedProcedure
    .input(z.object({
      requestId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await GDPRService.getRequestById(input.requestId, ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get all GDPR requests for user
   */
  getMyRequests: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await GDPRService.getUserRequests(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Cancel pending GDPR request (within grace period)
   */
  cancelRequest: protectedProcedure
    .input(z.object({
      requestId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await GDPRService.cancelRequest(
        input.requestId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'FORBIDDEN'
            ? result.error.code
            : result.error.code === 'INVALID_STATE'
            ? 'BAD_REQUEST'
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // CONSENT MANAGEMENT
  // --------------------------------------------------------------------------
  
  /**
   * Get user consent status (for specific type or all)
   */
  getConsentStatus: protectedProcedure
    .input(z.object({
      consentType: z.enum(['marketing', 'analytics', 'location', 'notifications', 'profiling', 'account_creation', 'email_notifications']).optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await GDPRService.getConsentStatus(
        ctx.user.id,
        input.consentType
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
   * Update user consent (grant or revoke)
   * 
   * GDPR-3: Consent records use UPSERT (schema has UNIQUE(user_id, consent_type))
   * This updates existing consent or creates new one
   */
  updateConsent: protectedProcedure
    .input(z.object({
      consentType: z.enum([
        'marketing',
        'analytics',
        'location',
        'notifications',
        'profiling',
        'account_creation',
        'email_notifications',
        'biometric_data',
      ]), // Restricted to known valid types — prevents consent record pollution
      purpose: z.string().min(1), // Required in schema (TEXT)
      granted: z.boolean(), // true = grant, false = revoke/withdraw
      userAgent: z.string().optional(), // Optional user agent for audit
      // ipAddress intentionally removed from input — derived server-side from ctx.ip
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const result = await GDPRService.updateConsent({
        userId: ctx.user.id,
        consentType: input.consentType,
        purpose: input.purpose,
        granted: input.granted,
        ipAddress: ctx.ip ?? undefined, // Server-derived, never caller-supplied
        userAgent: input.userAgent,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
