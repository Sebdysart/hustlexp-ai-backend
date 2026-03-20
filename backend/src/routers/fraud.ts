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
import { router, adminProcedure, Schemas } from '../trpc.js';
import { FraudDetectionService, type FraudPatternStatus, type RiskScoreStatus } from '../services/FraudDetectionService.js';
import { db } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'fraud-router' });

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
      // A-24: bound keys and array length to prevent unbounded input
      componentScores: z.record(z.string().max(100), z.number()).optional().refine(
        (val) => !val || Object.keys(val).length <= 50,
        'Too many component scores',
      ),
      flags: z.array(z.string().max(200)).max(50).optional(), // A-24: bounded flag strings
      reason: z.string().max(1000).optional(), // Reason for manual risk score update
    }))
    .mutation(async ({ input, ctx }) => {
      // Fetch previous score for audit trail before writing the new one
      const previousResult = await FraudDetectionService.getLatestRiskScore(
        input.entityType,
        input.entityId,
      );
      const previousScore = previousResult.success ? previousResult.data?.risk_score ?? null : null;

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: input.entityType,
        entityId: input.entityId,
        riskScore: input.riskScore,
        componentScores: input.componentScores,
        flags: input.flags || [],
      });

      if (!result.success) {
        // A-25: BAD_REQUEST (validation) errors are user-facing — pass message through.
        // INTERNAL_SERVER_ERROR must never expose raw DB/service messages.
        if (result.error.code === 'INVALID_INPUT') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.message });
        }
        log.error({ err: result.error.message, procedure: 'calculateRiskScore' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
      }

      // Audit log: record every manual risk score update so changes are traceable
      const targetUserId = input.entityType === 'user' ? input.entityId : null;
      await db.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata, created_at)
         VALUES ($1, 'risk_score_update', $2, $3, $4, NOW())`,
        [
          ctx.user!.id,
          targetUserId,
          input.reason ?? null,
          JSON.stringify({
            entity_type: input.entityType,
            entity_id: input.entityId,
            previous_score: previousScore,
            new_score: input.riskScore,
            reason: input.reason ?? null,
          }),
        ],
      ).catch(() => {
        // Audit log failure must not block the risk score write — log only
      });

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
        input.entityId,
      );

      if (!result.success) {
        // A-25: never expose raw service error messages on INTERNAL_SERVER_ERROR
        log.error({ err: result.error.message, procedure: 'getLatestRiskScore' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
        input.entityId,
      );

      if (!result.success) {
        // NOT_FOUND is a user-meaningful response; pass message through.
        // All other failures are internal — use generic message.
        if (result.error.code === 'NOT_FOUND') {
          throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
        }
        log.error({ err: result.error.message, procedure: 'getRiskAssessment' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
        input.limit,
      );

      if (!result.success) {
        // A-25: never expose raw service error messages on INTERNAL_SERVER_ERROR
        log.error({ err: result.error.message, procedure: 'getHighRiskScores' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
      reviewNotes: z.string().max(5000).optional(), // A-23: bound review notes
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
        input.reviewNotes,
      );

      if (!result.success) {
        if (result.error.code === 'NOT_FOUND') {
          throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
        }
        log.error({ err: result.error.message, procedure: 'updateRiskScoreStatus' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
      patternType: z.enum([
        // CRITICAL patterns
        'payment_fraud',
        'identity_theft',
        'money_laundering',
        'account_takeover',
        'coordinated_fraud_ring',
        // HIGH risk patterns
        'self_matching',
        'multiple_accounts',
        'unusual_transaction_volume',
        'suspicious_payment_pattern',
        'account_simultaneity',
        // MEDIUM risk patterns
        'rapid_account_creation',
        'abnormal_task_patterns',
        'unusual_rating_patterns',
      ]),
      patternDescription: z.string().min(1).max(5000), // A-24: bound description length
      userIds: z.array(Schemas.uuid).min(1).max(100), // At least one user, at most 100 (A-08: mass suspension guard)
      taskIds: z.array(Schemas.uuid).max(100).optional(),
      transactionIds: z.array(Schemas.uuid).max(100).optional(),
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
        if (result.error.code === 'INVALID_INPUT') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.message });
        }
        log.error({ err: result.error.message, procedure: 'detectPattern' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
        input.status as FraudPatternStatus | undefined,
      );

      if (!result.success) {
        // A-25: never expose raw service error messages on INTERNAL_SERVER_ERROR
        log.error({ err: result.error.message, procedure: 'getUserPatterns' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
        input.limit,
      );

      if (!result.success) {
        // A-25: never expose raw service error messages on INTERNAL_SERVER_ERROR
        log.error({ err: result.error.message, procedure: 'getDetectedPatterns' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
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
      reviewDecision: z.string().max(100).optional(), // A-23: 'confirmed', 'dismissed', etc.
      reviewNotes: z.string().max(5000).optional(),   // A-23: bound review notes
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
        input.reviewNotes,
      );

      if (!result.success) {
        if (result.error.code === 'NOT_FOUND') {
          throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
        }
        log.error({ err: result.error.message, procedure: 'updatePatternStatus' }, 'Fraud service error');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred. Contact support if this persists.' });
      }

      return result.data;
    }),
});
