/**
 * Fraud Detection Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §14, FRAUD_DETECTION_SPEC.md
 * 
 * Endpoints for fraud detection, risk scoring, and pattern recognition.
 * All endpoints require admin access.
 * 
 * @see backend/src/services/FraudDetectionService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure, Schemas } from '../trpc';
import { FraudDetectionService, type EntityType, type RiskLevel, type FraudPatternStatus, type RiskScoreStatus } from '../services/FraudDetectionService';

export const fraudRouter = router({
  // --------------------------------------------------------------------------
  // RISK SCORING
  // --------------------------------------------------------------------------
  
  /**
   * Calculate and store risk score for an entity (user, task, transaction)
   * 
   * FRAUD_DETECTION_SPEC.md §1.2: Risk score calculation
   */
  calculateRiskScore: adminProcedure
    .input(z.object({
      entityType: z.enum(['user', 'task', 'transaction']),
      entityId: Schemas.uuid,
      riskScore: z.number().min(0.0).max(1.0), // 0.0 to 1.0
      componentScores: z.record(z.number()).optional(), // Optional breakdown of risk components
      flags: z.array(z.string()).optional(), // Optional array of flag strings
    }))
    .mutation(async ({ input }) => {
      const result = await FraudDetectionService.calculateRiskScore({
        entityType: input.entityType,
        entityId: input.entityId,
        riskScore: input.riskScore,
        componentScores: input.componentScores,
        flags: input.flags || [],
      });
      
      if (!result.success) {
        let code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'INVALID_INPUT') {
          code = 'BAD_REQUEST';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get latest risk score for an entity
   */
  getLatestRiskScore: adminProcedure
    .input(z.object({
      entityType: z.enum(['user', 'task', 'transaction']),
      entityId: Schemas.uuid,
    }))
    .query(async ({ input }) => {
      const result = await FraudDetectionService.getLatestRiskScore(
        input.entityType,
        input.entityId
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
   * Get risk assessment with recommendation
   * 
   * FRAUD_DETECTION_SPEC.md §1.1: Action based on risk level
   */
  getRiskAssessment: adminProcedure
    .input(z.object({
      entityType: z.enum(['user', 'task', 'transaction']),
      entityId: Schemas.uuid,
    }))
    .query(async ({ input }) => {
      const result = await FraudDetectionService.getRiskAssessment(
        input.entityType,
        input.entityId
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get active high-risk scores (for admin review queue)
   */
  getHighRiskScores: adminProcedure
    .input(z.object({
      minRiskScore: z.number().min(0.0).max(1.0).default(0.6),
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input }) => {
      const result = await FraudDetectionService.getHighRiskScores(
        input.minRiskScore,
        input.limit
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
   * Update risk score status (admin review)
   */
  updateRiskScoreStatus: adminProcedure
    .input(z.object({
      riskScoreId: Schemas.uuid,
      status: z.enum(['active', 'reviewed', 'resolved', 'dismissed']),
      reviewNotes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await FraudDetectionService.updateRiskScoreStatus(
        input.riskScoreId,
        input.status as RiskScoreStatus,
        ctx.user.id,
        input.reviewNotes
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // FRAUD PATTERNS
  // --------------------------------------------------------------------------
  
  /**
   * Detect and record a fraud pattern
   * 
   * FRAUD_DETECTION_SPEC.md §2: Pattern detection
   */
  detectPattern: adminProcedure
    .input(z.object({
      patternType: z.string().min(1).max(50), // e.g., 'self_matching', 'multiple_accounts'
      patternDescription: z.string().min(1),
      userIds: z.array(Schemas.uuid).min(1), // At least one user required
      taskIds: z.array(Schemas.uuid).optional(),
      transactionIds: z.array(Schemas.uuid).optional(),
      evidence: z.record(z.any()).optional(), // Optional evidence data
    }))
    .mutation(async ({ input }) => {
      const result = await FraudDetectionService.detectPattern({
        patternType: input.patternType,
        patternDescription: input.patternDescription,
        userIds: input.userIds,
        taskIds: input.taskIds,
        transactionIds: input.transactionIds,
        evidence: input.evidence,
      });
      
      if (!result.success) {
        let code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'INVALID_INPUT') {
          code = 'BAD_REQUEST';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get fraud patterns for a user
   */
  getUserPatterns: adminProcedure
    .input(z.object({
      userId: Schemas.uuid,
      status: z.enum(['detected', 'reviewed', 'confirmed', 'dismissed']).optional(),
    }))
    .query(async ({ input }) => {
      const result = await FraudDetectionService.getUserPatterns(
        input.userId,
        input.status as FraudPatternStatus | undefined
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
   * Get detected fraud patterns (for admin review queue)
   */
  getDetectedPatterns: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input }) => {
      const result = await FraudDetectionService.getDetectedPatterns(
        input.limit
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
   * Update fraud pattern status (admin review)
   */
  updatePatternStatus: adminProcedure
    .input(z.object({
      patternId: Schemas.uuid,
      status: z.enum(['detected', 'reviewed', 'confirmed', 'dismissed']),
      reviewDecision: z.string().optional(), // 'confirmed', 'dismissed', etc.
      reviewNotes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await FraudDetectionService.updatePatternStatus(
        input.patternId,
        input.status as FraudPatternStatus,
        ctx.user.id,
        input.reviewDecision,
        input.reviewNotes
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
