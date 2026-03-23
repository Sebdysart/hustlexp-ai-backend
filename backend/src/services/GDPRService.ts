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
import Stripe from 'stripe';
import { db, isInvariantViolation, getErrorMessage } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { NotificationService } from './NotificationService.js';
import { EscrowService } from './EscrowService.js';
import { TaskService } from './TaskService.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { invalidateAuthCacheForUser } from '../auth-cache.js';
import { forceDisconnectUser } from '../realtime/connection-registry.js';
import { revokeUserSessions } from '../auth/middleware.js';

// Module-level Stripe singleton — only instantiated when a real key is present.
// Matches the pattern used in TippingService.ts.
let stripe: Stripe | null = null;
if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
}

// ============================================================================
// D53-4: PER-USER IN-MEMORY RATE LIMITER FOR GDPR ENDPOINTS
// ============================================================================
// Cooldown periods (milliseconds)
const GDPR_DELETION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const GDPR_EXPORT_COOLDOWN_MS = 60 * 60 * 1000;         // 1 hour

// Map key: `${userId}:${requestType}` → timestamp of last allowed request
const gdprRateLimitMap = new Map<string, number>();

/**
 * Check whether a GDPR request from userId is within the cooldown window.
 * Returns { allowed: true } if the request can proceed and records the
 * current timestamp. Returns { allowed: false, retryAfterMs } when within
 * the cooldown window.
 *
 * Exported for unit-testing. Called by createRequest before any DB work.
 */
export function checkGDPRRateLimit(
  userId: string,
  requestType: 'deletion' | 'export' | string
): { allowed: boolean; retryAfterMs?: number } {
  const cooldownMs = requestType === 'deletion'
    ? GDPR_DELETION_COOLDOWN_MS
    : GDPR_EXPORT_COOLDOWN_MS;

  const key = `${userId}:${requestType}`;
  const now = Date.now();
  const last = gdprRateLimitMap.get(key);

  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < cooldownMs) {
      return { allowed: false, retryAfterMs: cooldownMs - elapsed };
    }
  }

  // Record the timestamp and allow
  gdprRateLimitMap.set(key, now);
  return { allowed: true };
}

/**
 * Clear all rate-limit state. ONLY for use in tests — never call in production.
 * Vitest runs each test file in a separate module context but all tests within
 * the same file share module state. This function allows beforeEach hooks to
 * reset the Map so rate-limit tests don't bleed into createRequest tests.
 */
export function _resetGDPRRateLimitMapForTesting(): void {
  gdprRateLimitMap.clear();
}

const log = logger.child({ service: 'GDPRService' });

// ============================================================================
// TYPES
// ============================================================================

// Schema uses lowercase for request_type: 'export', 'deletion', 'rectification', 'restriction'
export type GDPRRequestType = 'export' | 'deletion' | 'rectification' | 'restriction';
// Schema uses lowercase for status: 'pending', 'processing', 'completed', 'rejected', 'cancelled'
export type GDPRRequestStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'cancelled';
// Schema uses lowercase for consent_type
export type ConsentType = 'marketing' | 'analytics' | 'location' | 'notifications' | 'profiling' | 'account_creation' | 'email_notifications' | 'biometric_data';
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
      // D53-4: Enforce per-user rate limit before doing any DB work.
      // Deletion: 24-hour cooldown. Export: 1-hour cooldown.
      if (requestType === 'deletion' || requestType === 'export') {
        const rateCheck = checkGDPRRateLimit(userId, requestType);
        if (!rateCheck.allowed) {
          return {
            success: false,
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: `Too many ${requestType} requests. Please wait before submitting another.`,
            },
          };
        }
      }

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
      
      // Queue background job to process request via BullMQ outbox pattern
      const requestId = result.rows[0].id;

      if (requestType === 'export') {
        // Immediately trigger export generation (writes outbox event → BullMQ)
        GDPRService.generateExport(requestId).catch(err => {
          log.error({ err: err instanceof Error ? err.message : String(err), requestId }, 'Failed to trigger export');
        });
      } else if (requestType === 'deletion') {
        // Deletion has a grace period — schedule via outbox for deadline processing
        // For now, deletion requests remain 'pending' until grace period expires
        // Admin or cron job will call executeDeletion after deadline
        log.info({ requestId, deadline: deadline.toISOString() }, 'Deletion request created with grace period');
      }
      // rectification requests are handled via UI/API — no background job needed

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
      // CAS guard: only cancel if still in a cancellable state. This prevents a race
      // where a concurrent export completion transitions the row to 'completed' between
      // the status check above and this UPDATE, which would overwrite 'completed' with
      // 'cancelled' (export file exists in R2 but user is told the request was cancelled).
      const result = await db.query<GDPRDataRequest>(
        `UPDATE gdpr_data_requests
         SET status = 'cancelled', processed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing')
         RETURNING *`,
        [requestId, userId]
      );

      if (result.rowCount === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot cancel request: status has already changed (request may have completed concurrently)',
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
          log.info({ exportId, idempotencyKey }, 'Outbox event already exists for export');
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
        log.error({ err: dbError instanceof Error ? dbError.message : String(dbError), requestId }, 'Failed to update GDPR request status');
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
      if (request.status === 'completed') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Erasure request already completed',
          },
        };
      }
      if (request.status === 'processing') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Erasure request is already being processed',
          },
        };
      }
      // D52-3: 'rejected' means a previous anonymization attempt failed mid-flight.
      // All 'rejected' paths in this service come from internal DB/transaction errors,
      // not from permanent policy rejections (those result in 'cancelled' via cancelRequest).
      // Therefore, allow 'rejected' requests to re-enter the deletion flow for
      // admin-triggered retries. The CAS update below will re-transition to 'processing'.

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
      
      // CAS update: atomically transition from 'pending'/'rejected' → 'processing'.
      // 'pending' = initial state, 'rejected' = prior attempt failed (retryable).
      // If another worker already started processing, rowCount will be 0 and we bail
      // immediately — preventing concurrent deleteAndAnonymizeUserData calls.
      // D52-3: include 'rejected' to allow admin-triggered retries after failure.
      const casResult = await db.query<{ id: string }>(
        `UPDATE gdpr_data_requests
         SET status = 'processing', processed_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'rejected') AND deadline <= NOW()
         RETURNING id`,
        [requestId]
      );
      if (casResult.rowCount === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Erasure request is already being processed by another worker',
          },
        };
      }
      
      // Execute data deletion/anonymization (GDPR_COMPLIANCE_SPEC.md §3.1, §3.2, §3.3)
      const userId = request.user_id;

      // Look up firebase_uid BEFORE deletion so we can write the Redis revocation
      // marker using the correct key namespace (auth:revoked:<firebaseUid>).
      // BUG GG1 FIX: marker must be keyed on firebaseUid, not DB UUID.
      const fbRow = await db.query<{ firebase_uid: string | null }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [userId]
      );
      const firebaseUid = fbRow.rows[0]?.firebase_uid ?? undefined;

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

      // Immediately evict auth cache and force-disconnect SSE streams for the
      // deleted user so the cached pre-deletion user row cannot be reused and
      // any live connections are terminated without waiting for TTL expiry.
      // BUG GG3 FIX: await the call (was fire-and-forget) so Redis errors surface.
      await invalidateAuthCacheForUser(userId, firebaseUid);
      forceDisconnectUser(userId);

      // BUG GG2 FIX: revoke Firebase refresh tokens and write the Redis revocation
      // marker for the Hono middleware path.  This was never called on GDPR deletion,
      // meaning deleted users could re-authenticate immediately.
      if (firebaseUid) {
        await revokeUserSessions(firebaseUid).catch(err => {
          log.error({ err: err instanceof Error ? err.message : String(err), userId }, 'revokeUserSessions failed during GDPR deletion — user may be able to re-authenticate');
        });
      }

      const completedAt = new Date();
      const deletedAt = completedAt;

      // Update request as completed
      await db.query<GDPRDataRequest>(
        `UPDATE gdpr_data_requests
         SET status = 'completed',
             processed_at = $1,
             completed_at = $1
         WHERE id = $2
         RETURNING *`,
        [completedAt, requestId]
      );
      
      // Send final confirmation email to user via NotificationService (outbox pattern)
      await NotificationService.createNotification({
        userId: request.user_id,
        category: 'security_alert',
        title: 'Account Deletion Completed',
        body: 'Your account and personal data have been permanently deleted per your GDPR request. This action cannot be undone.',
        deepLink: 'app://support',
        channels: ['email'], // D51-8: no in_app channel — user is deleted and cannot log in to see it
        priority: 'HIGH',
        metadata: { requestId, deletedAt: deletedAt.toISOString() },
      }).catch(err => {
        // Log but don't fail — user data is already deleted, notification is best-effort
        log.error({ err: err instanceof Error ? err.message : String(err), userId: request.user_id, requestId }, 'Failed to send deletion confirmation');
      });
      
      return {
        success: true,
        data: { deletedAt },
      };
    } catch (error) {
      // Mark request as failed (use schema-valid 'rejected' status)
      await db.query(
        `UPDATE gdpr_data_requests
         SET status = 'rejected',
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
    const { userId, consentType, ipAddress, userAgent } = params;
    
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

  // --------------------------------------------------------------------------
  // BIPA COMPLIANCE (740 ILCS 14)
  // --------------------------------------------------------------------------

  /**
   * Check if user has granted biometric data consent.
   * BIPA requires written consent BEFORE biometric data collection.
   *
   * @returns true if user has an active biometric_data consent with granted=true
   */
  hasBiometricConsent: async (userId: string): Promise<boolean> => {
    try {
      const result = await db.query<{ granted: boolean }>(
        `SELECT granted FROM user_consents
         WHERE user_id = $1 AND consent_type = 'biometric_data'
         AND granted = true
         LIMIT 1`,
        [userId]
      );
      return result.rows.length > 0;
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to check biometric consent');
      // Fail closed: if we can't verify consent, deny access
      return false;
    }
  },

  // D53-4: Expose checkGDPRRateLimit as a service method so it can be used
  // by the tRPC router and tested directly through GDPRService.
  checkGDPRRateLimit,
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
      `SELECT id, task_id, sender_id, receiver_id, message_type, content,
              photo_urls, created_at
       FROM task_messages
       WHERE (sender_id = $1 OR receiver_id = $1)
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
      `SELECT push_enabled, email_enabled, sms_enabled,
              quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
              category_preferences, created_at, updated_at
       FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );
    
    // 11. GDPR consent history
    const consentHistoryResult = await db.query(
      `SELECT consent_type, purpose, granted, granted_at, withdrawn_at,
              ip_address, user_agent, created_at, updated_at
       FROM user_consents WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 12. Saved searches
    const savedSearchesResult = await db.query(
      `SELECT id, name, query, filters, sort_by, created_at
       FROM saved_searches WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    // 13. Task applications (D52-2: user's own applications as hustler)
    const taskApplicationsResult = await db.query(
      `SELECT ta.id, ta.task_id, ta.message, ta.status, ta.created_at AS applied_at
       FROM task_applications ta
       WHERE ta.hustler_id = $1
       ORDER BY ta.created_at DESC`,
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
      task_applications: taskApplicationsResult.rows,
    };
    
    return exportData;
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to collect user data for export');
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
    // D53-1 FIX: Use randomUUID() for the anonymizedId instead of a deterministic
    // ID derived from the real userId. The old approach embedded the last 12 hex
    // characters of userId in the node segment, making re-identification trivial.
    //
    // Idempotency (retry-safe): Before generating a new UUID we check whether the
    // user row already has the deleted-*@deleted.hustlexp.app email pattern. If it
    // does, the row was already anonymized by a previous run — return success early
    // without overwriting existing anonymization data. This replaces the previous
    // deterministic-ID approach as the idempotency mechanism.
    const userEmailCheck = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    const existingEmail = userEmailCheck.rows[0]?.email ?? '';
    if (/^deleted-.+@deleted\.hustlexp\.app$/.test(existingEmail)) {
      // Already anonymized — return early (idempotent re-run)
      log.info({ userId }, 'GDPR: user already anonymized — skipping re-run (idempotent)');
      return { success: true, data: { deletedAt: new Date() } };
    }

    // Generate a cryptographically random UUID for the anonymizedId. This is safe
    // for UUID-typed FK columns (proofs.submitter_id, task_applications.hustler_id,
    // fraud_risk_scores.entity_id) and carries zero information about the real userId.
    const anonymizedId = randomUUID();
    const anonymizedEmail = `deleted-${randomUUID().split('-')[0]}@deleted.hustlexp.app`;
    const deletedAt = new Date();

    // -------------------------------------------------------------------------
    // FIX 2: Cancel all non-terminal tasks where this user is the poster, and
    // refund any FUNDED escrows attached to those tasks. Must run BEFORE the
    // anonymization transaction so that TaskService/EscrowService can still
    // locate the task by poster_id and the escrow by task FK.
    // -------------------------------------------------------------------------
    const openPosterTasksResult = await db.query<{ id: string }>(
      `SELECT t.id FROM tasks t WHERE t.poster_id = $1
       AND t.state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
      [userId]
    );
    for (const row of openPosterTasksResult.rows) {
      try {
        const cancelResult = await TaskService.cancel(row.id);
        if (!cancelResult.success) {
          const errMsg = cancelResult.error?.message ?? '';
          if (errMsg.includes('INVALID_STATE') || errMsg.includes('TASK_TERMINAL')) {
            log.warn({ taskId: row.id, userId, err: errMsg }, 'GDPR: poster task already in terminal state — skipping cancel (idempotent retry)');
          } else {
            log.warn({ taskId: row.id, userId, err: errMsg }, 'GDPR: could not cancel poster task — continuing');
          }
        }
      } catch (cancelErr) {
        const errMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
        if (errMsg.includes('INVALID_STATE') || errMsg.includes('TASK_TERMINAL')) {
          log.warn({ taskId: row.id, userId, err: errMsg }, 'GDPR: poster task cancel threw INVALID_STATE — skipping (idempotent retry)');
        } else {
          log.warn({ taskId: row.id, userId, err: errMsg }, 'GDPR: poster task cancel threw unexpectedly — continuing');
        }
      }
      // Refund any FUNDED or PENDING escrow attached to this task.
      // PENDING escrows have a PaymentIntent created but not yet confirmed by
      // Stripe — cancel the PI first so money never moves, then refund the
      // escrow record. If Stripe later confirms the PI, the cancellation
      // prevents a stranded charge.
      // Also handle LOCKED_DISPUTE escrows where the poster is the deleted
      // user — return the full amount to the poster (100%) since the worker
      // cannot be paid to a deleted account's task.
      const escrowResult = await db.query<{ id: string; state: string; stripe_payment_intent_id: string | null }>(
        `SELECT id, state, stripe_payment_intent_id FROM escrows WHERE task_id = $1 AND state IN ('FUNDED', 'PENDING', 'LOCKED_DISPUTE')`,
        [row.id]
      );
      for (const escrow of escrowResult.rows) {
        if (escrow.state === 'PENDING' && escrow.stripe_payment_intent_id) {
          try {
            if (stripe) {
              await stripe.paymentIntents.cancel(escrow.stripe_payment_intent_id);
            }
          } catch (stripeErr) {
            log.warn({ escrowId: escrow.id, paymentIntentId: escrow.stripe_payment_intent_id, taskId: row.id, userId, err: stripeErr instanceof Error ? stripeErr.message : String(stripeErr) }, 'GDPR: could not cancel Stripe PaymentIntent for PENDING escrow — continuing with refund');
          }
        }
        if (escrow.state === 'LOCKED_DISPUTE') {
          // Poster is being deleted — return full amount to poster account
          // (100% poster, 0% worker) since the poster's task is being cleaned up.
          try {
            const refundResult = await EscrowService.partialRefund({ escrowId: escrow.id, workerPercent: 0, posterPercent: 100 });
            if (!refundResult.success) {
              const errMsg = refundResult.error?.message ?? '';
              if (errMsg.includes('INVALID_STATE')) {
                log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster LOCKED_DISPUTE escrow already in terminal state — skipping (idempotent retry)');
              } else {
                log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: could not partialRefund poster LOCKED_DISPUTE escrow — continuing');
              }
            }
          } catch (refundErr) {
            const errMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
            if (errMsg.includes('INVALID_STATE')) {
              log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster LOCKED_DISPUTE escrow partialRefund threw INVALID_STATE — skipping (idempotent retry)');
            } else {
              log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster LOCKED_DISPUTE escrow partialRefund threw unexpectedly — continuing');
            }
          }
        } else {
          try {
            const refundResult = await EscrowService.refund({ escrowId: escrow.id });
            if (!refundResult.success) {
              const errMsg = refundResult.error?.message ?? '';
              if (errMsg.includes('INVALID_STATE')) {
                log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster task escrow already in terminal state — skipping (idempotent retry)');
              } else {
                log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: could not refund poster task escrow — continuing');
              }
            }
          } catch (refundErr) {
            const errMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
            if (errMsg.includes('INVALID_STATE')) {
              log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster task escrow refund threw INVALID_STATE — skipping (idempotent retry)');
            } else {
              log.warn({ escrowId: escrow.id, taskId: row.id, userId, err: errMsg }, 'GDPR: poster task escrow refund threw unexpectedly — continuing');
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // FIX 1: Refund all FUNDED or LOCKED_DISPUTE escrows where this user is the
    // worker. Must run BEFORE nulling worker_id so EscrowService can still
    // locate the worker. FUNDED escrows are refunded via EscrowService.refund().
    // LOCKED_DISPUTE escrows are returned 100% to the poster via partialRefund().
    // -------------------------------------------------------------------------
    const workerEscrowsResult = await db.query<{ id: string; state: string }>(
      `SELECT e.id, e.state FROM escrows e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.worker_id = $1 AND e.state IN ('FUNDED', 'LOCKED_DISPUTE')`,
      [userId]
    );
    for (const row of workerEscrowsResult.rows) {
      if (row.state === 'FUNDED') {
        try {
          const refundResult = await EscrowService.refund({ escrowId: row.id });
          if (!refundResult.success) {
            const errMsg = refundResult.error?.message ?? '';
            if (errMsg.includes('INVALID_STATE')) {
              log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker FUNDED escrow already in terminal state — skipping (idempotent retry)');
            } else {
              log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: could not refund worker FUNDED escrow — continuing');
            }
          }
        } catch (refundErr) {
          const errMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
          if (errMsg.includes('INVALID_STATE')) {
            log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker FUNDED escrow refund threw INVALID_STATE — skipping (idempotent retry)');
          } else {
            log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker FUNDED escrow refund threw unexpectedly — continuing');
          }
        }
      } else if (row.state === 'LOCKED_DISPUTE') {
        // Return full amount to poster (0% to deleted worker)
        try {
          const refundResult = await EscrowService.partialRefund({ escrowId: row.id, workerPercent: 0, posterPercent: 100 });
          if (!refundResult.success) {
            const errMsg = refundResult.error?.message ?? '';
            if (errMsg.includes('INVALID_STATE')) {
              log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker LOCKED_DISPUTE escrow already in terminal state — skipping (idempotent retry)');
            } else {
              log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: could not partialRefund worker LOCKED_DISPUTE escrow — continuing');
            }
          }
        } catch (refundErr) {
          const errMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
          if (errMsg.includes('INVALID_STATE')) {
            log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker LOCKED_DISPUTE escrow partialRefund threw INVALID_STATE — skipping (idempotent retry)');
          } else {
            log.warn({ escrowId: row.id, userId, err: errMsg }, 'GDPR: worker LOCKED_DISPUTE escrow partialRefund threw unexpectedly — continuing');
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // D58-8: Delete the Stripe customer via Stripe API before nulling the ID
    // in the DB. This is best-effort: if Stripe is unavailable or the customer
    // was already deleted, we log a warning and continue with the DB deletion.
    // The stripe_customer_id is still nulled in the UPDATE users SET below.
    // -------------------------------------------------------------------------
    const stripeCustomerRow = await db.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );
    const stripeCustomerId = stripeCustomerRow.rows[0]?.stripe_customer_id ?? null;
    if (stripeCustomerId && stripe) {
      try {
        await stripe.customers.del(stripeCustomerId);
      } catch (stripeErr) {
        log.warn(
          { userId, stripeCustomerId, err: stripeErr instanceof Error ? stripeErr.message : String(stripeErr) },
          'GDPR: could not delete Stripe customer via API — continuing with DB anonymization (best-effort)'
        );
      }
    }

    // Use a transaction to ensure atomicity
    await db.serializableTransaction(async (query) => {
      // 1. Immediate deletion (GDPR_COMPLIANCE_SPEC.md §3.1)

      // D53-2 FIX: Delete from tables that contain PII but were missing from the
      // original scrub. All confirmed in schema.sql with user_id FK columns.
      // Identity verification data — contains email, phone, status
      await query('DELETE FROM users_identity WHERE user_id = $1', [userId]);
      // Verification attempt records — contains target (email/phone), code_hash, ip_address
      await query('DELETE FROM verification_attempts WHERE user_id = $1', [userId]);
      // Identity events — contains ip_address, channel, metadata
      await query('DELETE FROM identity_events WHERE user_id = $1', [userId]);
      // User stats — aggregated stats linked to userId (no anonymization needed, delete)
      await query('DELETE FROM user_stats WHERE user_id = $1', [userId]);
      // Boost purchases — linked to userId
      await query('DELETE FROM user_boosts WHERE user_id = $1', [userId]);
      // Leaderboard cache — stores username, name, avatar_url (display PII)
      await query('DELETE FROM leaderboard_cache WHERE user_id = $1', [userId]);
      // Proactive AI preferences — stores categories, schedule, device_tokens
      await query('DELETE FROM proactive_preferences WHERE user_id = $1', [userId]);
      // Direct messages (messages table) — sender_id is the author column per schema.sql
      // messages.sender_id references users(id); content and image_url are PII
      await query('DELETE FROM messages WHERE sender_id = $1', [userId]);

      // Delete tables added after GDPR service was written
      await query('DELETE FROM alpha_telemetry WHERE user_id = $1', [userId]);
      await query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
      await query('DELETE FROM worker_skills WHERE user_id = $1', [userId]);
      await query('DELETE FROM xp_tax_ledger WHERE user_id = $1', [userId]);
      await query('DELETE FROM user_xp_tax_status WHERE user_id = $1', [userId]);
      await query('DELETE FROM insurance_contributions WHERE hustler_id = $1', [userId]);
      await query('DELETE FROM insurance_claims WHERE user_id = $1', [userId]);

      // D58-1: Delete worker_tax_info — contains SSN/EIN (CRITICAL PII).
      // worker_tax_info.user_id FK references users(id); cascade never fires
      // because users is UPDATEd not DELETEd.
      await query('DELETE FROM worker_tax_info WHERE user_id = $1', [userId]);

      // D58-2: Delete worker_stripe_accounts — contains Stripe Connect account IDs (CRITICAL).
      // worker_stripe_accounts.worker_id FK references users(id).
      await query('DELETE FROM worker_stripe_accounts WHERE worker_id = $1', [userId]);

      // D58-3: Delete worker_payout_settings and worker_earnings_1099 (HIGH PII).
      // Both use worker_id FK referencing users(id).
      await query('DELETE FROM worker_payout_settings WHERE worker_id = $1', [userId]);
      await query('DELETE FROM worker_earnings_1099 WHERE worker_id = $1', [userId]);

      // D58-4: Delete expertise tables — user_expertise, expertise_waitlist, expertise_change_log.
      // All use user_id FK referencing users(id); cascade never fires because users is UPDATEd.
      await query('DELETE FROM expertise_change_log WHERE user_id = $1', [userId]);
      await query('DELETE FROM expertise_waitlist WHERE user_id = $1', [userId]);
      await query('DELETE FROM user_expertise WHERE user_id = $1', [userId]);

      // D58-5: Delete featured_listings — poster_id NOT NULL FK referencing users(id).
      // Cascade never fires because users is UPDATEd not DELETEd.
      await query('DELETE FROM featured_listings WHERE poster_id = $1', [userId]);

      // D58-6: Delete task_matching_scores — hustler_id FK referencing users(id).
      await query('DELETE FROM task_matching_scores WHERE hustler_id = $1', [userId]);

      // D54-1: Delete tax_forms — contains PII (name_on_file, address_line1, city,
      // state, zip, tax_id_last4, stripe_connect_id, foreign_tax_id, signature_on_file).
      // The users UPDATE (not DELETE) means ON DELETE CASCADE never fires.
      await query('DELETE FROM tax_forms WHERE user_id = $1', [userId]);

      // D54-3: Delete squad membership and invitation data.
      // squad_members.user_id FK references users(id).
      await query('DELETE FROM squad_members WHERE user_id = $1', [userId]);
      // squad_invites has two user FK columns — delete rows where user is either party.
      await query(
        'DELETE FROM squad_invites WHERE inviter_id = $1 OR invitee_id = $1',
        [userId]
      );
      // squad_task_workers.worker_id FK references users(id).
      await query('DELETE FROM squad_task_workers WHERE worker_id = $1', [userId]);

      // D54-4: Delete additional tables containing user PII.
      // skill_verifications — contains skill_name, payment info linked to user.
      await query('DELETE FROM skill_verifications WHERE user_id = $1', [userId]);
      // insurance_subscriptions — contains tier, coverage, Stripe subscription ID linked to user.
      await query('DELETE FROM insurance_subscriptions WHERE user_id = $1', [userId]);
      // daily_challenge_completions — contains progress and completion status linked to user.
      await query('DELETE FROM daily_challenge_completions WHERE user_id = $1', [userId]);
      // tips — poster_id and worker_id both reference users(id); both sides must be covered.
      await query(
        'DELETE FROM tips WHERE poster_id = $1 OR worker_id = $1',
        [userId]
      );
      // D55-2: Delete poster_ratings where user is the rated poster or the rater.
      // Both poster_id and rated_by are NOT NULL and reference users(id).
      await query(
        'DELETE FROM poster_ratings WHERE poster_id = $1 OR rated_by = $1',
        [userId]
      );
      // D55-3: Delete live_sessions for this user (user_id NOT NULL, contains
      // earnings_cents and behavioural session data).
      await query('DELETE FROM live_sessions WHERE user_id = $1', [userId]);
      // D50-4: Delete evidence uploaded by this user (uploader_user_id is NOT NULL
      // in the schema, so UPDATE NULL is not possible — DELETE is required).
      // Note: evidence rows for active/completed disputes are not retained here
      // because the user's right to erasure takes precedence over record-keeping
      // for resolved disputes (GDPR Art. 17). Open dispute escrows are already
      // refunded above before we reach this point.
      await query('DELETE FROM evidence WHERE uploader_user_id = $1', [userId]);
      // D55-1: Delete dispute_evidence uploaded by this user (uploaded_by NOT NULL;
      // different table from evidence — has uploaded_by column, not uploader_user_id).
      await query('DELETE FROM dispute_evidence WHERE uploaded_by = $1', [userId]);
      // D60-A: dispute_jury_votes.juror_id is NOT NULL — must DELETE, not SET NULL.
      // Previous bug used wrong column name 'voter_id' (doesn't exist) causing
      // the entire transaction to roll back for users with jury vote records.
      await query('DELETE FROM dispute_jury_votes WHERE juror_id = $1', [userId]);
      await query('DELETE FROM plan_entitlements WHERE user_id = $1', [userId]);
      await query('DELETE FROM task_geofence_events WHERE user_id = $1', [userId]);

      // D57-1: Delete session_forecasts — financial behavioral forecasts per user.
      // user_id NOT NULL REFERENCES users(id); no ON DELETE CASCADE, and users is
      // UPDATEd (not DELETEd), so cascade never fires.
      await query('DELETE FROM session_forecasts WHERE user_id = $1', [userId]);

      // D57-2: Delete content_appeals — contains appeal_reason TEXT (PII).
      // user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE; cascade never fires
      // because users is UPDATEd not DELETEd.
      await query('DELETE FROM content_appeals WHERE user_id = $1', [userId]);

      // D57-3: Delete content_reports — contains description TEXT (PII).
      // Both reporter_user_id and reported_content_user_id are NOT NULL FKs.
      // Must cover both columns so all rows linking to the deleted user are removed.
      await query(
        'DELETE FROM content_reports WHERE reporter_user_id = $1 OR reported_content_user_id = $1',
        [userId]
      );

      // D57-4a: Delete recurring_task_series — poster_id NOT NULL, contains
      // title/description/location PII. ON DELETE CASCADE declared but never fires
      // because users is UPDATEd, not DELETEd.
      await query('DELETE FROM recurring_task_series WHERE poster_id = $1', [userId]);

      // D57-4b: Delete squads where user is the organizer.
      // organizer_id NOT NULL REFERENCES users(id) ON DELETE CASCADE; cascade never
      // fires since users is UPDATEd not DELETEd. organizer_id cannot be NULLed
      // (NOT NULL constraint), so we must DELETE the squad row (squad_members,
      // squad_invites, and squad_task_assignments cascade via their FK constraints).
      await query('DELETE FROM squads WHERE organizer_id = $1', [userId]);

      // Delete notification preferences
      await query(
        `DELETE FROM notification_preferences WHERE user_id = $1`,
        [userId]
      );

      // D50-2: Delete queued outbound emails containing PII (subject/body/recipient)
      await query('DELETE FROM email_outbox WHERE user_id = $1', [userId]);

      // D51-3: Delete outbox_events whose payload carries the deleted user's email
      // (outbox_events has no user_id column; identify rows via payload JSONB).
      await query(
        `DELETE FROM outbox_events WHERE payload->>'userId' = $1::text`,
        [userId]
      );

      // D51-4: Delete queued SMS rows (sms_outbox has a user_id column).
      await query('DELETE FROM sms_outbox WHERE user_id = $1', [userId]);

      // D50-3: Delete notification delivery log (contains PII in body/title columns)
      await query('DELETE FROM notification_log WHERE user_id = $1', [userId]);

      // Delete notifications (bodies contain PII: task descriptions, payment amounts, counterparty names)
      await query('DELETE FROM notifications WHERE user_id = $1', [userId]);

      // D50-6: Scrub notification bodies sent TO other users that contain this
      // user's message text. The notifications table links to tasks via task_id,
      // and task_messages links to tasks via task_id with sender_id. We clear the
      // body for any notification whose task_id matches a task where the deleted
      // user was the sender (covers message-preview notifications).
      await query(
        `UPDATE notifications n
         SET body = '[Message deleted per GDPR request]'
         WHERE n.task_id IN (
           SELECT DISTINCT tm.task_id
           FROM task_messages tm
           WHERE tm.sender_id = $1
         )
         AND n.user_id != $1`,
        [userId]
      );

      // D51-1: Remove senderId UUID from JSONB metadata on notifications for
      // tasks where the deleted user sent messages (covers message-preview
      // notifications sent to the counterparty that embed the sender's UUID).
      await query(
        `UPDATE notifications
         SET metadata = metadata - 'senderId'
         WHERE metadata ? 'senderId'
           AND task_id IN (
             SELECT DISTINCT task_id FROM task_messages WHERE sender_id = $1
           )`,
        [userId]
      );
      
      // Delete saved searches
      await query(
        `DELETE FROM saved_searches WHERE user_id = $1`,
        [userId]
      );
      
      // Delete analytics events (all records — GDPR Art. 17 requires full erasure)
      await query(
        `DELETE FROM analytics_events WHERE user_id = $1`,
        [userId]
      );
      
      // Delete consent history (no longer needed after account deletion)
      await query(
        `DELETE FROM user_consents WHERE user_id = $1`,
        [userId]
      );
      
      // 2. Anonymize account data (email, name, phone, and PII-linked Stripe IDs)
      // FIX 6: stripe_customer_id and stripe_connect_id are PII-linked identifiers
      // (Stripe stores name/email behind them). They must be cleared to satisfy GDPR
      // erasure. avatar_url (hosted photo) and bio are also PII and must be cleared.
      await query(
        `UPDATE users
         SET email = $1,
             name = 'Deleted User',
             phone = NULL,
             account_status = 'DELETED',
             paused_at = $2,
             stripe_customer_id = NULL,
             stripe_connect_id = NULL,
             avatar_url = NULL,
             bio = NULL,
             flagged_phrase_counter = '{}'::jsonb
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
      
      // Anonymize proofs where the user was the submitter
      // Only SET columns that actually exist on the proofs table
      await query(
        `UPDATE proofs
         SET submitter_id = $1,
             description = '[deleted]'
         WHERE submitter_id = $2`,
        [anonymizedId, userId]
      );

      // D52-1: Anonymize task_applications where user was the hustler.
      // hustler_id is NOT NULL UUID FK — replace with anonymizedId (valid UUID).
      // message TEXT may contain PII — overwrite with GDPR notice.
      await query(
        `UPDATE task_applications
         SET message = '[Application removed per GDPR request]',
             hustler_id = $2
         WHERE hustler_id = $1`,
        [userId, anonymizedId]
      );

      // Anonymize proof_submissions for the same user — GPS, biometric, and photo fields
      // are PII that live on proof_submissions, not proofs.
      // D58-7: photo_url also contains PII (photo of the worker at the job site).
      await query(
        `UPDATE proof_submissions
         SET photo_url = NULL,
             gps_coordinates = NULL,
             gps_accuracy_meters = NULL,
             biometric_verified = FALSE,
             biometric_confidence = NULL,
             face_match_score = NULL,
             liveness_score = NULL
         WHERE user_id = $1`,
        [userId]
      );

      // Anonymize task messages (sender_id and receiver_id are NOT NULL in schema)
      // Since user record is anonymized (not deleted), foreign keys remain valid
      // We anonymize content and remove photos for privacy for ALL matched rows
      // (both sent and received messages must be erased per GDPR)
      // D50-1: also clear location columns (lat/lon/expires) which are PII
      await query(
        `UPDATE task_messages
         SET content = '[Message deleted per GDPR request]',
             photo_urls = '{}'::TEXT[],
             location_latitude = NULL,
             location_longitude = NULL,
             location_expires_at = NULL,
             moderation_status = 'quarantined'
         WHERE sender_id = $1 OR receiver_id = $1`,
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
      
      // NOTE: xp_ledger and trust_ledger rows are financial audit records.
      // Their user_id columns are UUID FKs referencing users(id).
      // We do NOT update user_id here — the users row itself is already anonymized
      // (name, email, phone, etc. nulled out above), so these ledger rows remain
      // linked to the now-anonymized user row without violating FK constraints.
      // Attempting to set user_id = anonymizedId (a non-UUID string) would cause
      // a FK constraint violation and roll back the entire anonymization transaction.

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
         SET user_ids = array_remove(user_ids, $1::UUID)
         WHERE $1::UUID = ANY(user_ids)`,
        [userId]
      );
      
      // Anonymize fraud risk scores
      await query(
        `UPDATE fraud_risk_scores
         SET entity_id = $1  -- Replace with anonymized ID
         WHERE entity_type = 'user' AND entity_id = $2`,
        [anonymizedId, userId]
      );
      
      // Bug 3: Remove referral_codes linkage
      await query(
        `DELETE FROM referral_codes WHERE user_id = $1`,
        [userId]
      );

      // D60-B: referral_redemptions.referrer_id and referred_id are both NOT NULL —
      // cannot SET NULL. DELETE rows where user appears as either referrer or referred.
      await query(
        'DELETE FROM referral_redemptions WHERE referrer_id = $1 OR referred_id = $1',
        [userId]
      );

      // D61-2: content_moderation_queue.user_id is NOT NULL — DELETE rows instead of SET NULL.
      await query('DELETE FROM content_moderation_queue WHERE user_id = $1', [userId]);

      // D60-C: shadow_score_events.user_id is NOT NULL — must DELETE.
      // Contains behavioral scoring events which are PII.
      await query('DELETE FROM shadow_score_events WHERE user_id = $1', [userId]);

      // D60-D: license_verifications.user_id is NOT NULL — must DELETE.
      // Contains trade license numbers and issuing state data (PII).
      await query('DELETE FROM license_verifications WHERE user_id = $1', [userId]);

      // D60-E: insurance_verifications.user_id is NOT NULL — must DELETE.
      // Contains policy numbers and coverage amounts (PII).
      await query('DELETE FROM insurance_verifications WHERE user_id = $1', [userId]);

      // D60-F: background_checks.user_id is NOT NULL — must DELETE.
      // Contains background check results (PII).
      await query('DELETE FROM background_checks WHERE user_id = $1', [userId]);

      // D60-G: compliance_violations.user_id is nullable (ON DELETE SET NULL declared,
      // but never fires because users is UPDATEd not DELETEd). NULL the user_id and
      // also scrub ip_address and device_fingerprint which are PII.
      await query(
        `UPDATE compliance_violations
         SET user_id = NULL,
             ip_address = NULL,
             device_fingerprint = NULL
         WHERE user_id = $1`,
        [userId]
      );

      // D60-H: fraud_detection_events.user_id is nullable — SET NULL and clear details JSONB.
      await query(
        `UPDATE fraud_detection_events
         SET user_id = NULL,
             details = '{}'::JSONB
         WHERE user_id = $1`,
        [userId]
      );

      // D60-I: verification_earnings_ledger.user_id is NOT NULL — must DELETE.
      await query('DELETE FROM verification_earnings_ledger WHERE user_id = $1', [userId]);

      // D60-I: verification_earnings_tracking.user_id is the PK (NOT NULL) — must DELETE.
      await query('DELETE FROM verification_earnings_tracking WHERE user_id = $1', [userId]);

      // D61-9: Delete admin_roles — user_id NOT NULL UNIQUE FK references users(id).
      // After erasure the user's UUID must not remain as a live PK reference.
      await query('DELETE FROM admin_roles WHERE user_id = $1', [userId]);

      // FIX: Anonymize admin_actions — keep rows for financial audit trail, but
      // clear the free-text reason field and mark metadata with gdpr_deleted so
      // it's clear the subject has been deleted. Do NOT delete rows (audit trail).
      // D61-1: The correct column is target_user_id (not target_id).
      await query(
        `UPDATE admin_actions
         SET metadata = metadata || '{"gdpr_deleted": true}'::jsonb,
             reason = '[deleted]'
         WHERE target_user_id = $1`,
        [userId]
      );
    });
    
    return {
      success: true,
      data: { deletedAt },
    };
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to delete/anonymize user data');
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error during data deletion',
      },
    };
  }
}
