/**
 * AIDecisionService v1.0.0
 * 
 * CONSTITUTIONAL: Manages AI proposal decisions
 * 
 * Deterministic validators evaluate AI proposals and make final decisions.
 * Decisions track what was actually written (if accepted).
 * 
 * @see schema.sql §7.4 (ai_decisions table)
 * @see AI_INFRASTRUCTURE.md §6.4, §7.3
 */

import { db } from '../db';
import type { ServiceResult, AIDecision } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface CreateAIDecisionParams {
  proposalId: string;
  accepted: boolean;
  reasonCodes: string[];
  writes?: Record<string, unknown>;
  finalAuthor: string; // 'system', 'admin:usr_xxx', 'user:usr_xxx'
}

// ============================================================================
// SERVICE
// ============================================================================

export const AIDecisionService = {
  /**
   * Create a decision for an AI proposal
   */
  create: async (params: CreateAIDecisionParams): Promise<ServiceResult<AIDecision>> => {
    const { proposalId, accepted, reasonCodes, writes, finalAuthor } = params;
    
    try {
      const result = await db.query<AIDecision>(
        `INSERT INTO ai_decisions (
          proposal_id, accepted, reason_codes, writes, final_author
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [
          proposalId,
          accepted,
          reasonCodes,
          writes ? JSON.stringify(writes) : null,
          finalAuthor,
        ]
      );
      
      return { success: true, data: result.rows[0] };
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
   * Get decision by ID
   */
  getById: async (decisionId: string): Promise<ServiceResult<AIDecision>> => {
    try {
      const result = await db.query<AIDecision>(
        'SELECT * FROM ai_decisions WHERE id = $1',
        [decisionId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI decision ${decisionId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
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
   * Get decision by proposal ID
   */
  getByProposalId: async (proposalId: string): Promise<ServiceResult<AIDecision | null>> => {
    try {
      const result = await db.query<AIDecision>(
        'SELECT * FROM ai_decisions WHERE proposal_id = $1 ORDER BY decided_at DESC LIMIT 1',
        [proposalId]
      );
      
      return { success: true, data: result.rows[0] || null };
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
};

export default AIDecisionService;
