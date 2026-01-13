/**
 * FraudDetectionService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §14, FRAUD_DETECTION_SPEC.md
 * 
 * Implements fraud detection, risk scoring, and pattern recognition.
 * Core Principle: Fraud detection prevents platform abuse before it causes damage.
 * 
 * This service aligns the existing RiskScoreService with the constitutional schema.
 * 
 * @see schema.sql §11.7 (fraud_risk_scores, fraud_patterns tables)
 * @see PRODUCT_SPEC.md §14
 * @see staging/FRAUD_DETECTION_SPEC.md
 * @see src/services/RiskScoreService.ts (existing implementation to align)
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { NotificationService } from './NotificationService';

// ============================================================================
// TYPES
// ============================================================================

export type EntityType = 'user' | 'task' | 'transaction';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type FraudPatternStatus = 'detected' | 'reviewed' | 'confirmed' | 'dismissed';
export type RiskScoreStatus = 'active' | 'reviewed' | 'resolved' | 'dismissed';

export interface FraudRiskScore {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  risk_score: number; // DECIMAL(3,2) - 0.0 to 1.0
  risk_level: RiskLevel;
  component_scores: Record<string, number>; // JSONB - breakdown of risk components
  flags: string[]; // TEXT[] - array of flag strings
  status: RiskScoreStatus; // Default: 'active'
  reviewed_by?: string | null; // UUID of admin reviewer
  reviewed_at?: Date | null;
  review_notes?: string | null;
  calculated_at: Date;
}

export interface FraudPattern {
  id: string;
  pattern_type: string; // VARCHAR(50) - e.g., 'self_matching', 'multiple_accounts'
  pattern_description: string; // TEXT
  user_ids: string[]; // UUID[] - array of user UUIDs involved
  task_ids?: string[] | null; // UUID[] - optional task IDs
  transaction_ids?: string[] | null; // UUID[] - optional transaction IDs
  evidence: Record<string, unknown>; // JSONB - evidence data
  status: FraudPatternStatus; // Default: 'detected'
  reviewed_by?: string | null; // UUID of admin reviewer
  reviewed_at?: Date | null;
  review_decision?: string | null; // 'confirmed', 'dismissed', etc.
  review_notes?: string | null;
  detected_at: Date;
}

export interface CreateRiskScoreParams {
  entityType: EntityType;
  entityId: string;
  riskScore: number; // 0.0 to 1.0
  componentScores?: Record<string, number>;
  flags?: string[];
}

export interface CreateFraudPatternParams {
  patternType: string;
  patternDescription: string;
  userIds: string[]; // At least one user required
  taskIds?: string[];
  transactionIds?: string[];
  evidence?: Record<string, unknown>;
}

export interface RiskAssessment {
  entityType: EntityType;
  entityId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  componentScores: Record<string, number>;
  flags: string[];
  recommendation: 'auto_approve' | 'review' | 'manual_review' | 'auto_reject' | 'suspend';
}

// Risk score thresholds (FRAUD_DETECTION_SPEC.md §1.1)
const RISK_THRESHOLDS = {
  LOW: 0.3,      // 0.0 - 0.3
  MEDIUM: 0.6,   // 0.3 - 0.6
  HIGH: 0.8,     // 0.6 - 0.8
  CRITICAL: 1.0, // 0.8 - 1.0
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Determine risk level from fraud pattern type
 * Maps pattern types to risk levels for automated action determination
 * 
 * FRAUD_DETECTION_SPEC.md §2.3: Risk-based automated actions
 */
function determinePatternRiskLevel(patternType: string): RiskLevel {
  // CRITICAL patterns: Immediate suspension required
  const criticalPatterns = [
    'payment_fraud',
    'identity_theft',
    'money_laundering',
    'account_takeover',
    'coordinated_fraud_ring',
  ];
  
  // HIGH risk patterns: Flag for manual review
  const highRiskPatterns = [
    'self_matching',
    'multiple_accounts',
    'unusual_transaction_volume',
    'suspicious_payment_pattern',
    'account_simultaneity',
  ];
  
  // MEDIUM risk patterns: Monitor and flag
  const mediumRiskPatterns = [
    'rapid_account_creation',
    'abnormal_task_patterns',
    'unusual_rating_patterns',
  ];
  
  if (criticalPatterns.some(p => patternType.toLowerCase().includes(p))) {
    return 'CRITICAL';
  } else if (highRiskPatterns.some(p => patternType.toLowerCase().includes(p))) {
    return 'HIGH';
  } else if (mediumRiskPatterns.some(p => patternType.toLowerCase().includes(p))) {
    return 'MEDIUM';
  } else {
    // Default to LOW risk for unknown patterns (requires manual review)
    return 'LOW';
  }
}

// ============================================================================
// SERVICE
// ============================================================================

export const FraudDetectionService = {
  // --------------------------------------------------------------------------
  // RISK SCORING
  // --------------------------------------------------------------------------
  
  /**
   * Calculate and store risk score for an entity (user, task, transaction)
   * 
   * FRAUD_DETECTION_SPEC.md §1.2: Risk score calculation
   * 
   * This aligns with existing RiskScoreService but stores in constitutional schema
   */
  calculateRiskScore: async (
    params: CreateRiskScoreParams
  ): Promise<ServiceResult<FraudRiskScore>> => {
    const { entityType, entityId, riskScore, componentScores = {}, flags = [] } = params;
    
    try {
      // Validate risk score (0.0 to 1.0)
      if (riskScore < 0.0 || riskScore > 1.0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Risk score must be between 0.0 and 1.0',
          },
        };
      }
      
      // Determine risk level based on score
      let riskLevel: RiskLevel;
      if (riskScore < RISK_THRESHOLDS.LOW) {
        riskLevel = 'LOW';
      } else if (riskScore < RISK_THRESHOLDS.MEDIUM) {
        riskLevel = 'MEDIUM';
      } else if (riskScore < RISK_THRESHOLDS.HIGH) {
        riskLevel = 'HIGH';
      } else {
        riskLevel = 'CRITICAL';
      }
      
      // Store risk score (schema allows multiple scores per entity with UNIQUE(entity_type, entity_id, calculated_at))
      const result = await db.query<FraudRiskScore>(
        `INSERT INTO fraud_risk_scores (
          entity_type, entity_id, risk_score, risk_level,
          component_scores, flags, status
        )
        VALUES ($1, $2, $3, $4, $5::JSONB, $6::TEXT[], 'active')
        RETURNING *`,
        [
          entityType,
          entityId,
          riskScore,
          riskLevel,
          JSON.stringify(componentScores),
          flags,
        ]
      );
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get latest risk score for an entity
   */
  getLatestRiskScore: async (
    entityType: EntityType,
    entityId: string
  ): Promise<ServiceResult<FraudRiskScore | null>> => {
    try {
      const result = await db.query<FraudRiskScore>(
        `SELECT * FROM fraud_risk_scores
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY calculated_at DESC
         LIMIT 1`,
        [entityType, entityId]
      );
      
      return {
        success: true,
        data: result.rows[0] || null,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get risk assessment with recommendation
   * 
   * FRAUD_DETECTION_SPEC.md §1.1: Action based on risk level
   */
  getRiskAssessment: async (
    entityType: EntityType,
    entityId: string
  ): Promise<ServiceResult<RiskAssessment>> => {
    try {
      const scoreResult = await FraudDetectionService.getLatestRiskScore(entityType, entityId);
      
      if (!scoreResult.success || !scoreResult.data) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `No risk score found for ${entityType} ${entityId}`,
          },
        };
      }
      
      const score = scoreResult.data;
      
      // Determine recommendation based on risk level
      let recommendation: RiskAssessment['recommendation'];
      switch (score.risk_level) {
        case 'LOW':
          recommendation = 'auto_approve';
          break;
        case 'MEDIUM':
          recommendation = 'review';
          break;
        case 'HIGH':
          recommendation = 'manual_review';
          break;
        case 'CRITICAL':
          recommendation = 'auto_reject';
          break;
        default:
          recommendation = 'review';
      }
      
      return {
        success: true,
        data: {
          entityType: score.entity_type,
          entityId: score.entity_id,
          riskScore: score.risk_score,
          riskLevel: score.risk_level,
          componentScores: score.component_scores,
          flags: score.flags,
          recommendation,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get active high-risk scores (for admin review queue)
   */
  getHighRiskScores: async (
    minRiskScore: number = 0.6,
    limit: number = 100
  ): Promise<ServiceResult<FraudRiskScore[]>> => {
    try {
      const result = await db.query<FraudRiskScore>(
        `SELECT * FROM fraud_risk_scores
         WHERE risk_score >= $1 AND status = 'active'
         ORDER BY risk_score DESC, calculated_at DESC
         LIMIT $2`,
        [minRiskScore, limit]
      );
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Update risk score status (admin review)
   */
  updateRiskScoreStatus: async (
    riskScoreId: string,
    status: RiskScoreStatus,
    reviewedBy: string,
    reviewNotes?: string
  ): Promise<ServiceResult<FraudRiskScore>> => {
    try {
      const result = await db.query<FraudRiskScore>(
        `UPDATE fraud_risk_scores
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_notes = $3
         WHERE id = $4
         RETURNING *`,
        [status, reviewedBy, reviewNotes || null, riskScoreId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Risk score ${riskScoreId} not found`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // FRAUD PATTERNS
  // --------------------------------------------------------------------------
  
  /**
   * Detect and record a fraud pattern
   * 
   * FRAUD_DETECTION_SPEC.md §2: Pattern detection
   */
  detectPattern: async (
    params: CreateFraudPatternParams
  ): Promise<ServiceResult<FraudPattern>> => {
    const {
      patternType,
      patternDescription,
      userIds,
      taskIds,
      transactionIds,
      evidence = {},
    } = params;
    
    try {
      // Validate: At least one user required
      if (!userIds || userIds.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'At least one user_id is required for fraud pattern',
          },
        };
      }
      
      // Create fraud pattern
      const result = await db.query<FraudPattern>(
        `INSERT INTO fraud_patterns (
          pattern_type, pattern_description, user_ids, task_ids, transaction_ids,
          evidence, status
        )
        VALUES ($1, $2, $3::UUID[], $4::UUID[], $5::UUID[], $6::JSONB, 'detected')
        RETURNING *`,
        [
          patternType,
          patternDescription,
          userIds,
          taskIds || null,
          transactionIds || null,
          JSON.stringify(evidence),
        ]
      );
      
      // Trigger automated actions based on pattern type
      // Determine risk level from pattern type
      const riskLevel = determinePatternRiskLevel(patternType);
      
      // Apply automated actions based on risk level
      if (riskLevel === 'CRITICAL') {
        // CRITICAL patterns: Auto-suspend accounts, alert admins
        for (const userId of userIds) {
          await db.query(
            `UPDATE users 
             SET account_status = 'SUSPENDED', paused_at = NOW()
             WHERE id = $1 AND account_status != 'SUSPENDED'`,
            [userId]
          );
          
          // Create high-priority risk score for suspended user
          await FraudDetectionService.createRiskScore({
            entityType: 'user',
            entityId: userId,
            riskScore: 0.95, // CRITICAL risk
            componentScores: {
              pattern_detection: 0.95,
              pattern_type: patternType,
            },
            flags: [`fraud_pattern_${patternType}`, 'auto_suspended'],
          });
        }
        
        // Alert admins (send notification to admin team)
        // TODO: Get admin user IDs from admin_roles table
        // For now, log critical fraud pattern for admin review
        console.error(`[CRITICAL FRAUD] Pattern ${patternType} detected for users: ${userIds.join(', ')}. Accounts auto-suspended.`);
        
        // Notify affected users of account suspension
        for (const userId of userIds) {
          await NotificationService.create({
            userId,
            category: 'account_suspended',
            title: 'Account Suspended',
            body: 'Your account has been temporarily suspended due to detected fraudulent activity. Please contact support to appeal.',
            deepLink: 'app://support',
            metadata: { patternType, patternId: result.rows[0].id },
            channels: ['in_app', 'email'],
            priority: 'CRITICAL',
          }).catch(error => {
            console.error(`Failed to send suspension notification to user ${userId}:`, error);
          });
        }
      } else if (riskLevel === 'HIGH') {
        // HIGH risk patterns: Auto-flag accounts, require manual review
        for (const userId of userIds) {
          // Update user with fraud flag (add to inconsistency_flags or create risk score)
          await db.query(
            `UPDATE users 
             SET inconsistency_flags = array_append(COALESCE(inconsistency_flags, ARRAY[]::TEXT[]), $1)
             WHERE id = $2 AND ($1 = ANY(inconsistency_flags)) IS NOT TRUE`,
            [`fraud_pattern_${patternType}`, userId]
          );
          
          // Create high-priority risk score for flagged user
          await FraudDetectionService.createRiskScore({
            entityType: 'user',
            entityId: userId,
            riskScore: 0.75, // HIGH risk
            componentScores: {
              pattern_detection: 0.75,
              pattern_type: patternType,
            },
            flags: [`fraud_pattern_${patternType}`, 'requires_review'],
          });
        }
        
        // Flag for admin review (add to review queue)
        // TODO: Get admin user IDs from admin_roles table and notify admins
        // For now, high-risk patterns are logged for admin review via admin dashboard
        console.log(`[HIGH RISK FRAUD] Pattern ${patternType} detected for users: ${userIds.join(', ')}. Requires manual review.`);
      } else {
        // MEDIUM/LOW risk patterns: Flag for monitoring, no immediate action
        for (const userId of userIds) {
          await FraudDetectionService.createRiskScore({
            entityType: 'user',
            entityId: userId,
            riskScore: riskLevel === 'MEDIUM' ? 0.5 : 0.3,
            componentScores: {
              pattern_detection: riskLevel === 'MEDIUM' ? 0.5 : 0.3,
              pattern_type: patternType,
            },
            flags: [`fraud_pattern_${patternType}`, 'monitoring'],
          });
        }
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get fraud patterns for a user
   */
  getUserPatterns: async (
    userId: string,
    status?: FraudPatternStatus
  ): Promise<ServiceResult<FraudPattern[]>> => {
    try {
      let sql = `SELECT * FROM fraud_patterns
                 WHERE $1 = ANY(user_ids)`;
      const params: unknown[] = [userId];
      
      if (status) {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }
      
      sql += ` ORDER BY detected_at DESC`;
      
      const result = await db.query<FraudPattern>(sql, params);
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get detected fraud patterns (for admin review queue)
   */
  getDetectedPatterns: async (
    limit: number = 100
  ): Promise<ServiceResult<FraudPattern[]>> => {
    try {
      const result = await db.query<FraudPattern>(
        `SELECT * FROM fraud_patterns
         WHERE status = 'detected'
         ORDER BY detected_at DESC
         LIMIT $1`,
        [limit]
      );
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Update fraud pattern status (admin review)
   */
  updatePatternStatus: async (
    patternId: string,
    status: FraudPatternStatus,
    reviewedBy: string,
    reviewDecision?: string,
    reviewNotes?: string
  ): Promise<ServiceResult<FraudPattern>> => {
    try {
      const result = await db.query<FraudPattern>(
        `UPDATE fraud_patterns
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_decision = $3,
             review_notes = $4
         WHERE id = $5
         RETURNING *`,
        [status, reviewedBy, reviewDecision || null, reviewNotes || null, patternId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Fraud pattern ${patternId} not found`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // INTEGRATION WITH EXISTING RiskScoreService
  // --------------------------------------------------------------------------
  
  /**
   * Wrapper to integrate with existing RiskScoreService
   * 
   * This allows existing code to continue using RiskScoreService.scoreUser() etc.
   * while also storing results in the constitutional schema
   */
  storeRiskScoreFromExistingService: async (
    entityType: EntityType,
    entityId: string,
    riskScore: number,
    componentScores: Record<string, number>,
    flags: string[]
  ): Promise<ServiceResult<FraudRiskScore>> => {
    return FraudDetectionService.calculateRiskScore({
      entityType,
      entityId,
      riskScore: Math.min(1.0, Math.max(0.0, riskScore / 100)), // Convert 0-100 to 0.0-1.0
      componentScores,
      flags,
    });
  },
};
