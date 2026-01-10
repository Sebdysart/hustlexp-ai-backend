/**
 * AIProposalService v1.0.0
 * 
 * CONSTITUTIONAL: Manages AI proposals (A2 authority)
 * 
 * AI proposals are suggestions only. Deterministic validators make final decisions.
 * Proposals include confidence scoring and certainty tiers.
 * 
 * @see schema.sql §7.3 (ai_proposals table)
 * @see AI_INFRASTRUCTURE.md §6.3, §7.2
 */

import { db } from '../db';
import type { ServiceResult, AIProposal, CertaintyTier } from '../types';
import { createHash } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

interface CreateAIProposalParams {
  jobId: string;
  proposalType: string;
  proposal: Record<string, unknown>;
  confidence?: number;
  certaintyTier?: CertaintyTier;
  anomalyFlags?: string[];
  schemaVersion: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const AIProposalService = {
  /**
   * Create an AI proposal
   * Proposal is hashed for integrity verification
   */
  create: async (params: CreateAIProposalParams): Promise<ServiceResult<AIProposal>> => {
    const {
      jobId,
      proposalType,
      proposal,
      confidence,
      certaintyTier,
      anomalyFlags,
      schemaVersion,
    } = params;
    
    try {
      // Hash proposal (SHA-256)
      const proposalJson = JSON.stringify(proposal);
      const proposalHash = createHash('sha256').update(proposalJson).digest('hex');
      
      const result = await db.query<AIProposal>(
        `INSERT INTO ai_proposals (
          job_id, proposal_type, proposal, proposal_hash,
          confidence, certainty_tier, anomaly_flags, schema_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          jobId,
          proposalType,
          JSON.stringify(proposal),
          proposalHash,
          confidence,
          certaintyTier,
          anomalyFlags,
          schemaVersion,
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
   * Get proposal by ID
   */
  getById: async (proposalId: string): Promise<ServiceResult<AIProposal>> => {
    try {
      const result = await db.query<AIProposal>(
        'SELECT * FROM ai_proposals WHERE id = $1',
        [proposalId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI proposal ${proposalId} not found`,
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
   * Get proposals by job ID
   */
  getByJobId: async (jobId: string): Promise<ServiceResult<AIProposal[]>> => {
    try {
      const result = await db.query<AIProposal>(
        'SELECT * FROM ai_proposals WHERE job_id = $1 ORDER BY created_at DESC',
        [jobId]
      );
      
      return { success: true, data: result.rows };
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

export default AIProposalService;
