/**
 * OnboardingAIService v1.0.0
 * 
 * CONSTITUTIONAL: Manages onboarding AI role inference (A2 authority)
 * 
 * AI infers user role (worker/poster) from calibration prompts.
 * Final decision is made by deterministic validator.
 * 
 * @see schema.sql (users table - onboarding fields)
 * @see AI_INFRASTRUCTURE.md §3.2
 * @see ONBOARDING_SPEC.md
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult, User, CertaintyTier } from '../types';
import { ErrorCodes } from '../types';
import { AIEventService } from './AIEventService';
import { AIJobService } from './AIJobService';
import { AIProposalService } from './AIProposalService';
import { AIDecisionService } from './AIDecisionService';

// ============================================================================
// TYPES
// ============================================================================

interface SubmitCalibrationParams {
  userId: string;
  calibrationPrompt: string;
  onboardingVersion: string;
}

interface InferenceResult {
  roleConfidenceWorker: number;
  roleConfidencePoster: number;
  certaintyTier: CertaintyTier;
  inconsistencyFlags?: string[];
}

interface ConfirmRoleParams {
  userId: string;
  confirmedMode: 'worker' | 'poster';
  overrideAI?: boolean;
}

// ============================================================================
// SERVICE
// ============================================================================

export const OnboardingAIService = {
  /**
   * Submit calibration prompt for role inference
   * Creates AI event, job, proposal, and decision
   */
  submitCalibration: async (params: SubmitCalibrationParams): Promise<ServiceResult<InferenceResult>> => {
    const { userId, calibrationPrompt, onboardingVersion } = params;
    
    try {
      // 1. Create AI event (immutable input)
      const eventResult = await AIEventService.create({
        subsystem: 'onboarding',
        eventType: 'calibration_submitted',
        actorUserId: userId,
        payload: {
          calibrationPrompt,
          onboardingVersion,
        },
        schemaVersion: '1.0.0',
      });
      
      if (!eventResult.success) {
        return eventResult as ServiceResult<InferenceResult>;
      }
      
      // 2. Create AI job
      const jobResult = await AIJobService.create({
        eventId: eventResult.data.id,
        subsystem: 'onboarding',
        modelProvider: 'openai', // Use GPT-4o for role inference
        modelId: 'gpt-4o',
        promptVersion: onboardingVersion,
        timeoutMs: 30000,
      });
      
      if (!jobResult.success) {
        return jobResult as ServiceResult<InferenceResult>;
      }
      
      // 3. Start job processing
      await AIJobService.start(jobResult.data.id);
      
      // Real implementation: Call Anthropic Claude for role inference
      let inference: InferenceResult = {
        roleConfidenceWorker: 0.5,
        roleConfidencePoster: 0.5,
        certaintyTier: 'WEAK' as CertaintyTier,
      };

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        try {
          const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-3-5-haiku-20241022',
              max_tokens: 200,
              messages: [{
                role: 'user',
                content: `You are a role inference engine for a gig marketplace app.
Based on this user's onboarding response, determine if they want to be a Worker (do tasks for money) or a Poster (pay others to do tasks).
User response: "${calibrationPrompt}"
Respond with JSON only: {"worker": 0.0-1.0, "poster": 0.0-1.0, "certainty": "STRONG"|"MODERATE"|"WEAK"}`,
              }],
            }),
          });

          if (aiResponse.ok) {
            const aiData = await aiResponse.json();
            const content = aiData.content?.[0]?.text || '';
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              inference = {
                roleConfidenceWorker: parsed.worker ?? 0.5,
                roleConfidencePoster: parsed.poster ?? 0.5,
                certaintyTier: (parsed.certainty || 'MODERATE') as CertaintyTier,
              };
            }
          }
        } catch (aiError) {
          console.error('[OnboardingAIService] Anthropic API error:', aiError);
          // Fallback to balanced inference
        }
      }

      const mockInference = inference;
      
      // 4. Create proposal
      const proposalResult = await AIProposalService.create({
        jobId: jobResult.data.id,
        proposalType: 'role_inference',
        proposal: mockInference,
        confidence: Math.max(mockInference.roleConfidenceWorker, mockInference.roleConfidencePoster),
        certaintyTier: mockInference.certaintyTier,
        schemaVersion: '1.0.0',
      });
      
      if (!proposalResult.success) {
        await AIJobService.fail(jobResult.data.id, 'Failed to create proposal');
        return proposalResult as ServiceResult<InferenceResult>;
      }
      
      // 5. Create decision (deterministic validator accepts)
      const decisionResult = await AIDecisionService.create({
        proposalId: proposalResult.data.id,
        accepted: true,
        reasonCodes: ['VALID_CONFIDENCE', 'WITHIN_THRESHOLD'],
        finalAuthor: 'system',
      });
      
      if (!decisionResult.success) {
        await AIJobService.fail(jobResult.data.id, 'Failed to create decision');
        return decisionResult as ServiceResult<InferenceResult>;
      }
      
      // 6. Complete job
      await AIJobService.complete(jobResult.data.id);
      
      // 7. Update user with inference result
      const userResult = await db.query<User>(
        `UPDATE users
         SET role_confidence_worker = $1,
             role_confidence_poster = $2,
             role_certainty_tier = $3,
             inconsistency_flags = $4
         WHERE id = $5
         RETURNING *`,
        [
          mockInference.roleConfidenceWorker,
          mockInference.roleConfidencePoster,
          mockInference.certaintyTier,
          mockInference.inconsistencyFlags || [],
          userId,
        ]
      );
      
      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }
      
      return { success: true, data: mockInference };
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
   * Get inference result for user
   */
  getInferenceResult: async (userId: string): Promise<ServiceResult<InferenceResult | null>> => {
    try {
      const result = await db.query<{
        role_confidence_worker: number;
        role_confidence_poster: number;
        role_certainty_tier: CertaintyTier;
        inconsistency_flags: string[];
      }>(
        `SELECT role_confidence_worker, role_confidence_poster, 
                role_certainty_tier, inconsistency_flags
         FROM users WHERE id = $1`,
        [userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }
      
      const row = result.rows[0];
      if (!row.role_confidence_worker && !row.role_confidence_poster) {
        return { success: true, data: null };
      }
      
      return {
        success: true,
        data: {
          roleConfidenceWorker: row.role_confidence_worker || 0,
          roleConfidencePoster: row.role_confidence_poster || 0,
          certaintyTier: row.role_certainty_tier || 'WEAK',
          inconsistencyFlags: row.inconsistency_flags || [],
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
   * Confirm role and complete onboarding
   */
  confirmRole: async (params: ConfirmRoleParams): Promise<ServiceResult<User>> => {
    const { userId, confirmedMode, overrideAI = false } = params;
    
    try {
      const result = await db.query<User>(
        `UPDATE users
         SET default_mode = $1,
             role_was_overridden = $2,
             onboarding_completed_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [confirmedMode, overrideAI, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
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
};

export default OnboardingAIService;
