/**
 * GDPRService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §16, GDPR_COMPLIANCE_SPEC.md
 * 
 * Implements GDPR compliance: data export, deletion, consent management.
 * Core Principle: User data belongs to users. They control it.
 * 
 * CRITICAL: Legal requirement. Non-negotiable.
 * 
 * @see schema.sql §11.9 (gdpr_data_requests, user_consents tables)
 * @see PRODUCT_SPEC.md §16
 * @see staging/GDPR_COMPLIANCE_SPEC.md
 */

import { randomUUID } from 'crypto';
import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

// Schema uses lowercase for request_type: 'export', 'deletion', 'rectification', 'restriction'
export type GDPRRequestType = 'export' | 'deletion' | 'rectification' | 'restriction';
// Schema uses lowercase for status: 'pending', 'processing', 'completed', 'rejected', 'cancelled'
export type GDPRRequestStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'cancelled';
// Schema uses lowercase for consent_type
export type ConsentType = 'marketing' | 'analytics' | 'location' | 'notifications' | 'profiling' | 'account_creation' | 'email_notifications';
// Schema uses boolean 'granted' (not status enum)
export type ConsentStatus = 'GRANTED' | 'REVOKED'; // Internal type, maps to boolean granted

export interface GDPRDataRequest {
  id: string;
  user_id: string;
  request_type: GDPRRequestType; // 'export', 'deletion', 'rectification', 'restriction'
  request_details?: Record<string, unknown>; // JSONB field in schema
  status: GDPRRequestStatus; // 'pending', 'processing', 'completed', 'rejected', 'cancelled'
  processed_by?: string; // UUID of admin who processed it
  processed_at?: Date;
  result_url?: string; // Schema uses result_url (not export_url)
  result_expires_at?: Date; // Schema uses result_expires_at (not export_expires_at)
  requested_at: Date; // Schema uses requested_at (not created_at)
  deadline: Date; // Required in schema (30 days for export, 7 days for deletion)
  completed_at?: Date;
}

export interface UserConsent {
  id: string;
  user_id: string;
  consent_type: string; // VARCHAR(50) in schema
  purpose: string; // TEXT field in schema
  granted: boolean; // Schema uses boolean (not status enum)
  granted_at?: Date;
  withdrawn_at?: Date; // Schema uses withdrawn_at (not revoked_at)
  ip_address?: string;
  user_agent?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGDPRRequestParams {
  userId: string;
  requestType: GDPRRequestType; // 'export', 'deletion', 'rectification', 'restriction'
  requestDetails?: Record<string, unknown>; // Optional JSONB details
  exportFormat?: 'json' | 'csv' | 'pdf'; // For EXPORT type (lowercase in schema)
  scope?: string[]; // Optional: specific data categories for export
}

export interface CreateConsentParams {
  userId: string;
  consentType: string; // VARCHAR(50) in schema
  purpose: string; // TEXT field in schema (required)
  granted: boolean; // true = granted, false = revoked/withdrawn
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const GDPRService = {
  // --------------------------------------------------------------------------
  // GDPR REQUESTS
  // --------------------------------------------------------------------------
  
  /**
   * Create a GDPR data request (export, deletion, access, rectification)
   * 
   * GDPR_COMPLIANCE_SPEC.md §2.3, §3.2
   */
  createRequest: async (
    params: CreateGDPRRequestParams
  ): Promise<ServiceResult<GDPRDataRequest>> => {
    const { userId, requestType, exportFormat } = params;
    
    try {
      // Validate request type and format
      if (requestType === 'export' && !exportFormat) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Export format is required for export requests',
          },
        };
      }
      
      // Check for existing pending request of same type
      const existingResult = await db.query<{ id: string }>(
        `SELECT id FROM gdpr_data_requests
         WHERE user_id = $1 AND request_type = $2 AND status IN ('pending', 'processing')
         LIMIT 1`,
        [userId, requestType]
      );
      
      if (existingResult.rows.length > 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `You already have a ${requestType} request in progress`,
          },
        };
      }
      
      // Calculate deadline (30 days for export, 7 days for deletion, 30 days default)
      const deadlineDays = requestType === 'deletion' ? 7 : 30;
      const deadline = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000);
      
      // Build request_details JSONB
      const requestDetails: Record<string, unknown> = params.requestDetails || {};
      if (exportFormat) {
        requestDetails.format = exportFormat;
      }
      if (params.scope) {
        requestDetails.scope = params.scope;
      }
      
      // Create request
      const result = await db.query<GDPRDataRequest>(
        `INSERT INTO gdpr_data_requests (
          user_id, request_type, request_details, status, deadline
        )
        VALUES ($1, $2, $3::JSONB, 'pending', $4)
        RETURNING *`,
        [userId, requestType, JSON.stringify(requestDetails), deadline]
      );
      
      // Queue background job to process request
      // TODO: Integrate with background job queue (e.g., BullMQ, pg-boss, etc.)
      // For now, requests are created in 'pending' status and must be processed manually or via cron
      // 
      // When job queue is available:
      // - EXPORT: Queue job to call GDPRService.generateExport(requestId)
      // - DELETION: Schedule job for executeDeletion after grace period (deadline)
      // - ACCESS: Queue job to generate access report (similar to export)
      // - RECTIFICATION: Allow user to correct data via UI/API
      
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
   * Get GDPR request by ID
   */
  getRequestById: async (
    requestId: string,
    userId: string // Verify user owns the request
  ): Promise<ServiceResult<GDPRDataRequest>> => {
    try {
      const result = await db.query<GDPRDataRequest>(
        `SELECT * FROM gdpr_data_requests
         WHERE id = $1 AND user_id = $2`,
        [requestId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `GDPR request ${requestId} not found or you do not have permission to view it`,
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
  
  /**
   * Get all GDPR requests for a user
   */
  getUserRequests: async (
    userId: string
  ): Promise<ServiceResult<GDPRDataRequest[]>> => {
    try {
      const result = await db.query<GDPRDataRequest>(
        `SELECT * FROM gdpr_data_requests
         WHERE user_id = $1
         ORDER BY requested_at DESC`,
        [userId]
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
   * Cancel a pending GDPR request (within grace period for deletion)
   * 
   * GDPR_COMPLIANCE_SPEC.md §3.2: 7-day grace period for deletion
   */
  cancelRequest: async (
    requestId: string,
    userId: string
  ): Promise<ServiceResult<GDPRDataRequest>> => {
    try {
      // Verify request exists and user owns it
      const verifyResult = await db.query<{
        id: string;
        status: GDPRRequestStatus;
        request_type: GDPRRequestType;
        deadline: Date;
      }>(
        `SELECT id, status, request_type, deadline
         FROM gdpr_data_requests
         WHERE id = $1 AND user_id = $2`,
        [requestId, userId]
      );
      
      if (verifyResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `GDPR request ${requestId} not found or you do not have permission to cancel it`,
          },
        };
      }
      
      const request = verifyResult.rows[0];
      
      // Can only cancel pending or processing requests
      if (request.status !== 'pending' && request.status !== 'processing') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot cancel request: status is ${request.status}. Only pending or processing requests can be cancelled`,
          },
        };
      }
      
      // For deletion requests, can only cancel within grace period (before deadline)
      if (request.request_type === 'deletion') {
        const now = new Date();
        const deadline = new Date(request.deadline);
        
        if (now >= deadline) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: 'Cannot cancel deletion: grace period has expired. Deletion will proceed as scheduled',
            },
          };
        }
      }
      
      // Cancel request (schema uses 'cancelled', lowercase)
      const result = await db.query<GDPRDataRequest>(
        `UPDATE gdpr_data_requests
         SET status = 'cancelled', processed_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [requestId, userId]
      );
      
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
  // DATA EXPORT
  // --------------------------------------------------------------------------
  
  /**
   * Generate data export for a user (background job via outbox pattern)
   * 
   * GDPR_COMPLIANCE_SPEC.md §2.1, §2.2
   * 
   * PHASE B: Exports End-to-End (via outbox pattern)
   * 
   * Pattern:
   * 1. Create exports table row (status='queued')
   * 2. Write outbox_event (event_type='export.requested')
   * 3. Return export_id immediately (no file generation inline)
   * 
   * Worker then processes the job:
   * - marks 'generating'
   * - generates file
   * - uploads to R2
   * - marks 'ready' with object_key, sha256, signed_url_expires_at
   * 
   * Hard rule: No file generation inline - must be async via worker
   */
  generateExport: async (
    requestId: string
  ): Promise<ServiceResult<{ exportId: string }>> => {
    try {
      // Get request (including request_details which contains format)
      const requestResult = await db.query<{
        id: string;
        user_id: string;
        status: GDPRRequestStatus;
        request_details: Record<string, unknown>;
      }>(
        'SELECT id, user_id, status, request_details FROM gdpr_data_requests WHERE id = $1',
        [requestId]
      );
      
      if (requestResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `GDPR request ${requestId} not found`,
          },
        };
      }
      
      const request = requestResult.rows[0];
      
      if (request.status !== 'pending' && request.status !== 'processing') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot generate export: request status is ${request.status}`,
          },
        };
      }
      
      // Get export format from request_details (default to 'json')
      const exportFormat = (request.request_details?.format as string) || 'json';
      if (!['json', 'csv', 'pdf'].includes(exportFormat)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: `Invalid export format: ${exportFormat}. Must be 'json', 'csv', or 'pdf'`,
          },
        };
      }
      
      const userId = request.user_id;
      
      // Determine content type based on format
      const contentTypeMap: Record<string, string> = {
        json: 'application/json',
        csv: 'text/csv',
        pdf: 'application/pdf',
      };
      const contentType = contentTypeMap[exportFormat] || 'application/json';
      
      // Use transaction to create export and outbox event atomically
      const { generateIdempotencyKey } = await import('../jobs/queues');
      
      const result = await db.transaction(async (query) => {
        // Update GDPR request status to processing
        await query(
          `UPDATE gdpr_data_requests
           SET status = 'processing', processed_at = NOW()
           WHERE id = $1`,
          [requestId]
        );
        
        // Create exports table row (status='queued')
        const exportResult = await query<{ id: string }>(
          `INSERT INTO exports (
            gdpr_request_id,
            user_id,
            export_format,
            content_type,
            status
          ) VALUES ($1, $2, $3, $4, 'queued')
          RETURNING id`,
          [requestId, userId, exportFormat, contentType]
        );
        
        const exportId = exportResult.rows[0].id;
        
        // Write outbox_event (event_type='export.requested') within same transaction
        // This will be picked up by outbox worker and enqueued to BullMQ
        const idempotencyKey = generateIdempotencyKey('export.requested', exportId, 1);
        
        // Check for duplicate (idempotency key must be unique)
        const existing = await query(
          `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        
        if (existing.rows.length === 0) {
          // Insert new outbox event within transaction
          await query(
            `INSERT INTO outbox_events (
              event_type,
              aggregate_type,
              aggregate_id,
              event_version,
              idempotency_key,
              payload,
              queue_name,
              status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
            [
              'export.requested',
              'export',
              exportId,
              1,
              idempotencyKey,
              JSON.stringify({
                exportId,
                userId,
                format: exportFormat,
                gdprRequestId: requestId,
              }),
              'exports',
            ]
          );
        } else {
          // Event already exists - idempotent write (shouldn't happen, but handle gracefully)
          console.log(`Outbox event already exists for export ${exportId} (idempotency key: ${idempotencyKey})`);
        }
        
        return { exportId };
      });
      
      // Return export_id immediately (no file generation inline)
      return {
        success: true,
        data: {
          exportId: result.exportId,
        },
      };
    } catch (error) {
      // Mark request as rejected (schema uses 'rejected', not 'failed')
      await db.query(
        `UPDATE gdpr_data_requests
         SET status = 'rejected',
             processed_at = NOW()
         WHERE id = $1`,
        [requestId]
      ).catch(dbError => {
        console.error(`Failed to update GDPR request ${requestId} status:`, dbError);
      });
      
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
  // DATA DELETION
  // --------------------------------------------------------------------------
  
  /**
   * Execute data deletion (background job)
   * 
   * GDPR_COMPLIANCE_SPEC.md §3.1, §3.2, §3.3
   * 
   * This should be called by a background job processor after grace period
   */
  executeDeletion: async (
    requestId: string
  ): Promise<ServiceResult<{ deletedAt: Date }>> => {
    try {
      // Get request
      const requestResult = await db.query<{
        id: string;
        user_id: string;
        status: GDPRRequestStatus;
        request_type: GDPRRequestType;
        deadline: Date;
      }>(
        'SELECT id, user_id, status, request_type, deadline FROM gdpr_data_requests WHERE id = $1',
        [requestId]
      );
      
      if (requestResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `GDPR request ${requestId} not found`,
          },
        };
      }
      
      const request = requestResult.rows[0];
      
      if (request.status === 'cancelled') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot execute deletion: request was cancelled',
          },
        };
      }
      
      // Verify deadline has passed (grace period expired)
      const now = new Date();
      const deadline = new Date(request.deadline);
      
      if (now < deadline) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot execute deletion: grace period has not expired. Deadline: ${deadline.toISOString()}`,
          },
        };
      }
      
      // Update status to processing
      await db.query(
        `UPDATE gdpr_data_requests
         SET status = 'processing', processed_at = NOW()
         WHERE id = $1`,
        [requestId]
      );
      
      // Execute data deletion/anonymization (GDPR_COMPLIANCE_SPEC.md §3.1, §3.2, §3.3)
      const userId = request.user_id;
      const deletionResult = await deleteAndAnonymizeUserData(userId);
      
      if (!deletionResult.success) {
        // Mark request as failed
        // TypeScript should narrow this to { success: false; error: ServiceError }
        const errorMessage = deletionResult.error.message || 'Unknown error during data deletion';
        await db.query(
          `UPDATE gdpr_data_requests
           SET status = 'rejected',
               error_message = $1,
               processed_at = NOW()
           WHERE id = $2`,
          [errorMessage, requestId]
        );
        
        return deletionResult;
      }
      
      const completedAt = new Date();
      const deletedAt = completedAt;
      
      // Update request as completed
      const result = await db.query<GDPRDataRequest>(
        `UPDATE gdpr_data_requests
         SET status = 'completed',
             processed_at = $1,
             completed_at = $1
         WHERE id = $2
         RETURNING *`,
        [completedAt, requestId]
      );
      
      // TODO: Send final confirmation email to user
      // Requires: Email service (SendGrid, AWS SES, etc.)
      // NotificationService.create can be used once email channel is configured:
      // await NotificationService.create({
      //   userId: request.user_id,
      //   category: 'security_alert',
      //   title: 'Account deletion completed',
      //   body: `Your account and personal data have been permanently deleted per your GDPR request.`,
      //   deepLink: 'app://support',
      //   channels: ['email'],
      //   priority: 'HIGH',
      // });
      
      return {
        success: true,
        data: { deletedAt },
      };
    } catch (error) {
      // Mark request as failed
      await db.query(
        `UPDATE gdpr_data_requests
         SET status = 'FAILED',
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [error instanceof Error ? error.message : 'Unknown error', requestId]
      );
      
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
  // CONSENT MANAGEMENT
  // --------------------------------------------------------------------------
  
  /**
   * Grant or revoke consent
   * 
   * GDPR_COMPLIANCE_SPEC.md §4
   */
  updateConsent: async (
    params: CreateConsentParams
  ): Promise<ServiceResult<UserConsent>> => {
    const { userId, consentType, status, ipAddress, userAgent } = params;
    
    try {
      // Schema has UNIQUE(user_id, consent_type) constraint, so use UPSERT
      const now = new Date();
      const granted = params.granted;
      
      // Upsert consent (update if exists, insert if not)
      const result = await db.query<UserConsent>(
        `INSERT INTO user_consents (
          user_id, consent_type, purpose, granted, granted_at, withdrawn_at, ip_address, user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id, consent_type)
        DO UPDATE SET
          granted = EXCLUDED.granted,
          granted_at = CASE WHEN EXCLUDED.granted = true THEN EXCLUDED.granted_at ELSE user_consents.granted_at END,
          withdrawn_at = CASE WHEN EXCLUDED.granted = false THEN EXCLUDED.withdrawn_at ELSE user_consents.withdrawn_at END,
          ip_address = EXCLUDED.ip_address,
          user_agent = EXCLUDED.user_agent,
          updated_at = NOW()
        RETURNING *`,
        [
          userId,
          consentType,
          params.purpose, // Required in schema
          granted,
          granted ? now : null, // granted_at (if granted)
          granted ? null : now, // withdrawn_at (if revoked)
          ipAddress || null,
          userAgent || null,
        ]
      );
      
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
   * Get current consent status for a user
   */
  getConsentStatus: async (
    userId: string,
    consentType?: ConsentType
  ): Promise<ServiceResult<UserConsent[]>> => {
    try {
      let sql = `SELECT * FROM user_consents WHERE user_id = $1`;
      const params: unknown[] = [userId];
      
      if (consentType) {
        sql += ` AND consent_type = $2`;
        params.push(consentType);
      }
      
      sql += ` ORDER BY created_at DESC`;
      
      const result = await db.query<UserConsent>(sql, params);
      
      // Schema has UNIQUE(user_id, consent_type), so we should only get one per type
      // But return all for history if needed
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
};

// ============================================================================
// HELPER FUNCTIONS - GDPR DATA OPERATIONS
// ============================================================================

/**
 * Collect all user data for GDPR export
 * GDPR_COMPLIANCE_SPEC.md §2: Data export requirements
 * 
 * Collects all user data from all tables for export in requested format.
 * This function can be called synchronously or by a background job.
 */
/**
 * Collects all user data from all tables for export in requested format.
 * This function can be called synchronously or by a background job.
 * 
 * Exported for use by export worker (export-worker.ts)
 */
export async function collectUserDataForExport(userId: string): Promise<Record<string, unknown>> {
  try {
    // 1. Account information
    const userResult = await db.query<{
      id: string;
      email: string;
      name: string | null;
      phone: string | null;
      created_at: Date;
      account_status: string;
      current_level: number;
      xp_total: number;
      trust_tier: number;
      current_streak: number;
    }>(
      `SELECT id, email, name, phone, created_at, account_status, 
              current_level, xp_total, trust_tier, current_streak
       FROM users WHERE id = $1`,
      [userId]
    );
    
    const user = userResult.rows[0] || {};
    
    // 2. Task history (posted)
    const postedTasksResult = await db.query(
      `SELECT id, title, description, price, state, category, location, 
              deadline, created_at, completed_at
       FROM tasks WHERE poster_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 3. Task history (accepted/completed as worker)
    const workerTasksResult = await db.query(
      `SELECT id, title, description, price, state, category, location,
              deadline, accepted_at, completed_at
       FROM tasks WHERE worker_id = $1
       ORDER BY accepted_at DESC`,
      [userId]
    );
    
    // 4. Transaction history (escrows)
    const escrowsResult = await db.query(
      `SELECT id, task_id, amount_cents, state, funded_at, released_at, refunded_at
       FROM escrows WHERE task_id IN (
         SELECT id FROM tasks WHERE poster_id = $1 OR worker_id = $1
       )
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 5. Message history (last 90 days)
    const messagesResult = await db.query(
      `SELECT id, task_id, sender_id, recipient_id, message_type, content,
              photo_urls, created_at
       FROM task_messages
       WHERE (sender_id = $1 OR recipient_id = $1)
       AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 6. Rating history (given and received)
    const ratingsGivenResult = await db.query(
      `SELECT id, ratee_id, task_id, rating, comment, is_public, created_at
       FROM task_ratings WHERE rater_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    const ratingsReceivedResult = await db.query(
      `SELECT id, rater_id, task_id, rating, comment, is_public, created_at
       FROM task_ratings WHERE ratee_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 7. Trust tier history (trust_ledger)
    const trustLedgerResult = await db.query(
      `SELECT id, task_id, old_tier, new_tier, reason, created_at
       FROM trust_ledger WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 8. XP history (xp_ledger)
    const xpLedgerResult = await db.query(
      `SELECT id, task_id, escrow_id, base_xp, effective_xp, reason, awarded_at
       FROM xp_ledger WHERE user_id = $1
       ORDER BY awarded_at DESC`,
      [userId]
    );
    
    // 9. Analytics events (last 90 days)
    const analyticsResult = await db.query(
      `SELECT id, event_type, properties, session_id, created_at
       FROM analytics_events
       WHERE user_id = $1
       AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 10. Notification preferences
    const notificationPrefsResult = await db.query(
      `SELECT * FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );
    
    // 11. GDPR consent history
    const consentHistoryResult = await db.query(
      `SELECT * FROM user_consents WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 12. Saved searches
    const savedSearchesResult = await db.query(
      `SELECT * FROM saved_searches WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // Compile export data
    const exportData = {
      export_date: new Date().toISOString(),
      user_id: userId,
      account: user,
      tasks_posted: postedTasksResult.rows,
      tasks_worked: workerTasksResult.rows,
      transactions: escrowsResult.rows,
      messages_last_90_days: messagesResult.rows,
      ratings_given: ratingsGivenResult.rows,
      ratings_received: ratingsReceivedResult.rows,
      trust_tier_history: trustLedgerResult.rows,
      xp_history: xpLedgerResult.rows,
      analytics_events_last_90_days: analyticsResult.rows,
      notification_preferences: notificationPrefsResult.rows[0] || null,
      consent_history: consentHistoryResult.rows,
      saved_searches: savedSearchesResult.rows,
    };
    
    return exportData;
  } catch (error) {
    console.error(`Failed to collect user data for export (userId: ${userId}):`, error);
    throw error;
  }
}

/**
 * Delete and anonymize user data according to GDPR requirements
 * GDPR_COMPLIANCE_SPEC.md §3.1, §3.2, §3.3: Data deletion and anonymization
 * 
 * This function:
 * 1. Immediately deletes/anonymizes account and profile data
 * 2. Anonymizes transaction/task/dispute data (7-year retention)
 * 3. Deletes analytics and location data
 * 
 * This should be called by a background job processor after grace period.
 */
async function deleteAndAnonymizeUserData(userId: string): Promise<ServiceResult<{ deletedAt: Date }>> {
  try {
    // Generate anonymization ID
    const anonymizedId = `DELETED_USER_${randomUUID().split('-')[0].toUpperCase()}`;
    const anonymizedEmail = `deleted-${randomUUID().split('-')[0]}@deleted.hustlexp.app`;
    const deletedAt = new Date();
    
    // Use a transaction to ensure atomicity
    await db.serializableTransaction(async (query) => {
      // 1. Immediate deletion (GDPR_COMPLIANCE_SPEC.md §3.1)
      
      // Delete notification preferences
      await query(
        `DELETE FROM notification_preferences WHERE user_id = $1`,
        [userId]
      );
      
      // Delete saved searches
      await query(
        `DELETE FROM saved_searches WHERE user_id = $1`,
        [userId]
      );
      
      // Delete analytics events (last 90 days - older ones should already be purged)
      await query(
        `DELETE FROM analytics_events 
         WHERE user_id = $1 
         AND created_at >= NOW() - INTERVAL '90 days'`,
        [userId]
      );
      
      // Delete consent history (no longer needed after account deletion)
      await query(
        `DELETE FROM user_consents WHERE user_id = $1`,
        [userId]
      );
      
      // 2. Anonymize account data (email, name, phone)
      await query(
        `UPDATE users
         SET email = $1,
             name = 'Deleted User',
             phone = NULL,
             account_status = 'DELETED',
             paused_at = $2
         WHERE id = $3`,
        [anonymizedEmail, deletedAt, userId]
      );
      
      // 3. Retention (7 years): Anonymize transaction/task/dispute data
      // Note: poster_id is NOT NULL, so we cannot set it to NULL
      // Instead, we anonymize task content while keeping the user_id reference
      // (the user record itself is already anonymized above)
      // Anonymize tasks where user is poster
      await query(
        `UPDATE tasks
         SET title = '[Deleted Task]',
             description = '[Content deleted per GDPR request]',
             location = NULL
         WHERE poster_id = $1`,
        [userId]
      );
      
      // Anonymize tasks where user is worker
      // worker_id is nullable, so we can set it to NULL for additional privacy
      await query(
        `UPDATE tasks
         SET worker_id = NULL  -- Remove user reference (worker_id is nullable)
         WHERE worker_id = $1`,
        [userId]
      );
      
      // Anonymize task messages (sender_id and recipient_id are NOT NULL in schema)
      // Since user record is anonymized (not deleted), foreign keys remain valid
      // We anonymize content and remove photos for privacy
      await query(
        `UPDATE task_messages
         SET content = CASE WHEN sender_id = $1 THEN '[Message deleted per GDPR request]' ELSE content END,
             photo_urls = CASE WHEN sender_id = $1 THEN '{}'::TEXT[] ELSE photo_urls END,
             moderation_status = 'quarantined'  -- Hide messages from deleted user
         WHERE sender_id = $1 OR recipient_id = $1`,
        [userId]
      );
      
      // Anonymize task ratings (rater_id and ratee_id are NOT NULL in schema)
      // Since user record is anonymized (not deleted), foreign keys remain valid
      // We remove comments for privacy (ratings themselves may be kept for aggregate stats)
      await query(
        `UPDATE task_ratings
         SET comment = NULL,  -- Remove all comments involving this user
             is_public = FALSE  -- Hide ratings from deleted user
         WHERE rater_id = $1 OR ratee_id = $1`,
        [userId]
      );
      
      // Anonymize XP ledger (keep XP data but anonymize user reference)
      await query(
        `UPDATE xp_ledger
         SET user_id = $1  -- Replace with anonymized ID
         WHERE user_id = $2`,
        [anonymizedId, userId]
      );
      
      // Anonymize trust ledger (keep trust data but anonymize user reference)
      await query(
        `UPDATE trust_ledger
         SET user_id = $1  -- Replace with anonymized ID
         WHERE user_id = $2`,
        [anonymizedId, userId]
      );
      
      // Anonymize disputes (poster_id, worker_id, initiated_by are NOT NULL in schema)
      // Since user record is anonymized (not deleted), foreign keys remain valid
      // We anonymize description content for privacy
      await query(
        `UPDATE disputes
         SET description = '[Dispute description deleted per GDPR request]',
             resolution_notes = CASE WHEN resolved_by = $1 THEN '[Resolution notes deleted per GDPR request]' ELSE resolution_notes END
         WHERE poster_id = $1 OR worker_id = $1 OR initiated_by = $1`,
        [userId]
      );
      
      // Anonymize fraud patterns (keep pattern data but remove user references)
      await query(
        `UPDATE fraud_patterns
         SET user_ids = array_remove(user_ids, $1::TEXT)
         WHERE $1::TEXT = ANY(user_ids)`,
        [userId]
      );
      
      // Anonymize fraud risk scores
      await query(
        `UPDATE fraud_risk_scores
         SET entity_id = $1  -- Replace with anonymized ID
         WHERE entity_type = 'user' AND entity_id = $2`,
        [anonymizedId, userId]
      );
      
      // Anonymize content moderation queue (keep moderation records but remove user reference)
      await query(
        `UPDATE content_moderation_queue
         SET user_id = NULL
         WHERE user_id = $1`,
        [userId]
      );
    });
    
    return {
      success: true,
      data: { deletedAt },
    };
  } catch (error) {
    console.error(`Failed to delete/anonymize user data (userId: ${userId}):`, error);
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error during data deletion',
      },
    };
  }
}
