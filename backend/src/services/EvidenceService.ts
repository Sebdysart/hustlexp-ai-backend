/**
 * EvidenceService v1.0.0
 * 
 * CONSTITUTIONAL: Manages evidence uploads for disputes/proofs
 * 
 * Evidence is stored in R2 with access control and retention policies.
 * Supports GPS metadata and moderation.
 * 
 * @see schema.sql §7.5 (evidence table)
 * @see AI_INFRASTRUCTURE.md §9
 */

import { db } from '../db';
import type { ServiceResult, Evidence, EvidenceAccessScope, EvidenceModerationStatus } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface CreateEvidenceParams {
  taskId?: string;
  disputeId?: string;
  proofId?: string;
  uploaderUserId: string;
  requestedBy: 'system' | 'poster' | 'admin';
  requestReasonCodes: string[];
  aiRequestProposalId?: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  captureTime?: Date;
  deviceMetadata?: Record<string, unknown>;
  accessScope?: EvidenceAccessScope;
  retentionDeadline: Date;
  legalHold?: boolean;
}

interface UpdateModerationParams {
  evidenceId: string;
  moderationStatus: EvidenceModerationStatus;
  moderationFlags?: string[];
}

// ============================================================================
// SERVICE
// ============================================================================

export const EvidenceService = {
  /**
   * Create evidence record
   * File should already be uploaded to R2 storage
   */
  create: async (params: CreateEvidenceParams): Promise<ServiceResult<Evidence>> => {
    const {
      taskId,
      disputeId,
      proofId,
      uploaderUserId,
      requestedBy,
      requestReasonCodes,
      aiRequestProposalId,
      storageKey,
      contentType,
      fileSizeBytes,
      checksumSha256,
      captureTime,
      deviceMetadata,
      accessScope = 'restricted',
      retentionDeadline,
      legalHold = false,
    } = params;
    
    try {
      const result = await db.query<Evidence>(
        `INSERT INTO evidence (
          task_id, dispute_id, proof_id, uploader_user_id,
          requested_by, request_reason_codes, ai_request_proposal_id,
          storage_key, content_type, file_size_bytes, checksum_sha256,
          capture_time, device_metadata, access_scope,
          retention_deadline, legal_hold, moderation_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')
        RETURNING *`,
        [
          taskId,
          disputeId,
          proofId,
          uploaderUserId,
          requestedBy,
          requestReasonCodes,
          aiRequestProposalId,
          storageKey,
          contentType,
          fileSizeBytes,
          checksumSha256,
          captureTime,
          deviceMetadata ? JSON.stringify(deviceMetadata) : null,
          accessScope,
          retentionDeadline,
          legalHold,
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
   * Get evidence by ID
   */
  getById: async (evidenceId: string): Promise<ServiceResult<Evidence>> => {
    try {
      const result = await db.query<Evidence>(
        'SELECT * FROM evidence WHERE id = $1 AND deleted_at IS NULL',
        [evidenceId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Evidence ${evidenceId} not found`,
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
   * Get evidence by dispute ID
   */
  getByDisputeId: async (disputeId: string): Promise<ServiceResult<Evidence[]>> => {
    try {
      const result = await db.query<Evidence>(
        'SELECT * FROM evidence WHERE dispute_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
        [disputeId]
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
  
  /**
   * Update moderation status
   */
  updateModeration: async (params: UpdateModerationParams): Promise<ServiceResult<Evidence>> => {
    const { evidenceId, moderationStatus, moderationFlags } = params;
    
    try {
      const result = await db.query<Evidence>(
        `UPDATE evidence
         SET moderation_status = $1, moderation_flags = $2
         WHERE id = $3
         RETURNING *`,
        [moderationStatus, moderationFlags, evidenceId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Evidence ${evidenceId} not found`,
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
   * Soft delete evidence (mark as deleted, respect retention policy)
   */
  delete: async (evidenceId: string): Promise<ServiceResult<Evidence>> => {
    try {
      const result = await db.query<Evidence>(
        `UPDATE evidence
         SET deleted_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [evidenceId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Evidence ${evidenceId} not found or already deleted`,
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
};

export default EvidenceService;
