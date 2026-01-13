/**
 * ContentModerationService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §15, CONTENT_MODERATION_SPEC.md
 * 
 * Implements content moderation: automated scanning, human review queue, user reporting.
 * Core Principle: Content moderation protects platform quality and user safety.
 * 
 * This service aligns existing ModerationService/SafetyService with the constitutional schema.
 * 
 * @see schema.sql §11.8 (content_moderation_queue, content_reports, content_appeals tables)
 * @see PRODUCT_SPEC.md §15
 * @see staging/CONTENT_MODERATION_SPEC.md
 * @see src/services/ModerationService.ts (existing implementation)
 * @see src/services/SafetyService.ts (existing implementation)
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { NotificationService } from './NotificationService';

// ============================================================================
// TYPES
// ============================================================================

export type ContentType = 'task' | 'message' | 'rating' | 'profile' | 'photo';
export type ModerationCategory = 'profanity' | 'harassment' | 'spam' | 'inappropriate' | 'personal_info' | 'phishing' | 'misleading';
export type ModerationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type FlaggedBy = 'ai' | 'user_report' | 'admin';
export type ModerationStatus = 'pending' | 'reviewing' | 'approved' | 'rejected' | 'escalated';
export type ReviewDecision = 'approve' | 'reject' | 'escalate' | 'no_action';
export type ReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';
export type AppealStatus = 'pending' | 'reviewing' | 'upheld' | 'overturned';

export interface ContentModerationQueueItem {
  id: string;
  content_type: ContentType;
  content_id: string;
  user_id: string;
  content_text?: string | null; // Snapshot at time of flag
  content_url?: string | null; // For photos
  moderation_category: string; // VARCHAR(50)
  severity: ModerationSeverity;
  ai_confidence?: number | null; // DECIMAL(3,2) - 0.0 to 1.0
  ai_recommendation?: 'approve' | 'flag' | 'block' | null;
  flagged_by: FlaggedBy;
  reporter_user_id?: string | null; // If user-reported
  status: ModerationStatus; // Default: 'pending'
  reviewed_by?: string | null;
  reviewed_at?: Date | null;
  review_decision?: ReviewDecision | null;
  review_notes?: string | null;
  flagged_at: Date;
  sla_deadline: Date; // SLA deadline based on severity
}

export interface ContentReport {
  id: string;
  reporter_user_id: string;
  content_type: ContentType;
  content_id: string;
  reported_content_user_id: string; // Schema uses reported_content_user_id (not reported_user_id)
  category: string; // VARCHAR(50) - schema uses 'category' (not 'report_category')
  description?: string | null; // TEXT - schema uses 'description' (not 'report_reason'), optional
  status: ReportStatus; // Default: 'pending'
  reviewed_by?: string | null;
  reviewed_at?: Date | null;
  review_decision?: string | null; // e.g., 'action_taken', 'no_action', 'dismissed'
  review_notes?: string | null;
  reported_at: Date;
}

export interface ContentAppeal {
  id: string;
  user_id: string;
  moderation_queue_id?: string | null; // Reference to moderation queue item
  original_decision: string; // VARCHAR(20) NOT NULL - required in schema (e.g., 'rejected', 'suspended')
  appeal_reason: string; // TEXT - user's explanation
  status: AppealStatus; // Default: 'pending'
  reviewed_by?: string | null;
  reviewed_at?: Date | null;
  review_decision?: string | null; // 'upheld', 'overturned'
  review_notes?: string | null;
  submitted_at: Date;
  deadline: Date; // TIMESTAMPTZ NOT NULL - required in schema (7/14/30 days from original action)
}

export interface ModerateContentParams {
  contentType: ContentType;
  contentId: string;
  userId: string;
  contentText?: string; // Snapshot at time of moderation
  contentUrl?: string; // For photos
  flaggedBy: FlaggedBy;
  reporterUserId?: string; // If user-reported
  aiConfidence?: number; // 0.0 to 1.0
  aiRecommendation?: 'approve' | 'flag' | 'block';
}

export interface CreateReportParams {
  reporterUserId: string;
  contentType: ContentType;
  contentId: string;
  reportedContentUserId: string; // Schema uses reported_content_user_id
  category: string; // Schema uses 'category' (not 'report_category')
  description?: string; // Schema uses 'description' (not 'report_reason'), optional
}

export interface CreateAppealParams {
  userId: string;
  moderationQueueId: string; // Required in schema (or content_report_id, but schema only has moderation_queue_id)
  originalDecision: string; // Required in schema (e.g., 'rejected', 'suspended', 'banned')
  appealReason: string;
  deadline: Date; // Required in schema (7/14/30 days from original action)
}

// SLA deadlines by severity (CONTENT_MODERATION_SPEC.md §3.1)
const SLA_DEADLINES: Record<ModerationSeverity, number> = {
  CRITICAL: 1, // 1 hour
  HIGH: 4, // 4 hours
  MEDIUM: 24, // 24 hours
  LOW: 48, // 48 hours
};

// Auto-action thresholds (CONTENT_MODERATION_SPEC.md §2.2)
const AUTO_BLOCK_THRESHOLD = 0.9; // AI confidence ≥ 0.9 → auto-block
const FLAG_THRESHOLD = 0.7; // AI confidence 0.7-0.9 → flag for review

// ============================================================================
// SERVICE
// ============================================================================

export const ContentModerationService = {
  // --------------------------------------------------------------------------
  // AUTOMATED CONTENT SCANNING
  // --------------------------------------------------------------------------
  
  /**
   * Moderate content and add to review queue if flagged
   * 
   * CONTENT_MODERATION_SPEC.md §2: Automated scanning with AI (A2 authority)
   * 
   * This integrates with existing ModerationService/SafetyService
   */
  moderateContent: async (
    params: ModerateContentParams
  ): Promise<ServiceResult<{ approved: boolean; queueItemId?: string }>> => {
    const {
      contentType,
      contentId,
      userId,
      contentText,
      contentUrl,
      flaggedBy,
      reporterUserId,
      aiConfidence,
      aiRecommendation,
    } = params;
    
    try {
      // Determine severity based on AI confidence or default to MEDIUM
      let severity: ModerationSeverity = 'MEDIUM';
      if (aiConfidence !== undefined) {
        if (aiConfidence >= AUTO_BLOCK_THRESHOLD) {
          severity = 'CRITICAL';
        } else if (aiConfidence >= FLAG_THRESHOLD) {
          severity = 'HIGH';
        } else if (aiConfidence >= 0.5) {
          severity = 'MEDIUM';
        } else {
          severity = 'LOW';
        }
      }
      
      // Determine moderation category based on AI analysis or pattern detection
      // TODO: Enhance with full AI analysis for richer category detection
      let moderationCategory: string = 'profanity'; // Default fallback
      
      // Basic category detection based on content patterns (pre-AI analysis)
      if (contentText) {
        const lowerText = contentText.toLowerCase();
        
        // Detect personal information (phone, email)
        if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(contentText) || 
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(contentText)) {
          moderationCategory = 'personal_info';
        }
        // Detect links/URLs (potential phishing/spam)
        else if (/https?:\/\/|www\./i.test(contentText)) {
          moderationCategory = 'phishing'; // Could be phishing or spam
        }
        // Detect profanity (basic pattern - full AI analysis will be more accurate)
        else if (/\b(fuck|shit|damn|bitch|asshole)\b/i.test(lowerText)) {
          moderationCategory = 'profanity';
        }
        // Detect harassment (repetitive negative content - basic heuristic)
        else if (/(hate|kill|die|stupid).{0,10}(you|u|ur|your)/i.test(lowerText)) {
          moderationCategory = 'harassment';
        }
        // Detect spam (repetitive content, excessive caps, etc.)
        else if (/[A-Z]{10,}|(buy|click|free|limited).{0,5}(now|today|offer)/i.test(lowerText)) {
          moderationCategory = 'spam';
        }
      }
      
      // If AI recommendation is provided, prioritize AI category analysis (future enhancement)
      // For now, use pattern-based detection above
      
      // If AI confidence < 0.5, approve without queueing
      if (aiConfidence !== undefined && aiConfidence < 0.5 && aiRecommendation === 'approve') {
        return {
          success: true,
          data: { approved: true },
        };
      }
      
      // If AI confidence ≥ 0.9 and recommendation is 'block', auto-reject
      if (aiConfidence !== undefined && aiConfidence >= AUTO_BLOCK_THRESHOLD && aiRecommendation === 'block') {
        // Auto-reject: Create queue item with status 'rejected' (no human review needed)
        const result = await db.query<ContentModerationQueueItem>(
          `INSERT INTO content_moderation_queue (
            content_type, content_id, user_id, content_text, content_url,
            moderation_category, severity, ai_confidence, ai_recommendation,
            flagged_by, reporter_user_id, status, flagged_at, sla_deadline
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'rejected', NOW(), NOW())
          RETURNING *`,
          [
            contentType,
            contentId,
            userId,
            contentText || null,
            contentUrl || null,
            moderationCategory,
            severity,
            aiConfidence || null,
            aiRecommendation || null,
            flaggedBy,
            reporterUserId || null,
          ]
        );
        
        // Auto-action: Hide/quarantine content immediately (high confidence auto-block)
        await applyModerationAction({
          contentType,
          contentId,
          action: 'quarantine', // Hide content from users
        });
        
        // Notify user that their content was automatically flagged
        await NotificationService.create({
          userId,
          category: 'security_alert',
          title: 'Content Flagged',
          body: 'Your content has been automatically flagged for review due to detected patterns. It will be reviewed by our moderation team.',
          deepLink: `app://content/${contentId}`,
          taskId: contentType === 'task' ? contentId : undefined,
          metadata: { contentType, contentId, moderationCategory, severity },
          channels: ['in_app', 'push'],
          priority: severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        }).catch(error => {
          // Log error but don't fail moderation process
          console.error(`Failed to send moderation notification to user ${userId}:`, error);
        });
        
        return {
          success: true,
          data: { approved: false, queueItemId: result.rows[0].id },
        };
      }
      
      // Flag for review: Create queue item with status 'pending'
      const slaDeadline = new Date(Date.now() + SLA_DEADLINES[severity] * 60 * 60 * 1000);
      
      const result = await db.query<ContentModerationQueueItem>(
        `INSERT INTO content_moderation_queue (
          content_type, content_id, user_id, content_text, content_url,
          moderation_category, severity, ai_confidence, ai_recommendation,
          flagged_by, reporter_user_id, status, flagged_at, sla_deadline
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW(), $12)
        RETURNING *`,
        [
          contentType,
          contentId,
          userId,
          contentText || null,
          contentUrl || null,
          moderationCategory,
          severity,
          aiConfidence || null,
          aiRecommendation || null,
          flaggedBy,
          reporterUserId || null,
          slaDeadline,
        ]
      );
      
      return {
        success: true,
        data: { approved: false, queueItemId: result.rows[0].id },
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
  
  // --------------------------------------------------------------------------
  // REVIEW QUEUE
  // --------------------------------------------------------------------------
  
  /**
   * Get pending moderation queue items (for admin review)
   */
  getPendingQueue: async (
    severity?: ModerationSeverity,
    limit: number = 100
  ): Promise<ServiceResult<ContentModerationQueueItem[]>> => {
    try {
      let sql = `SELECT * FROM content_moderation_queue WHERE status = 'pending'`;
      const params: unknown[] = [];
      
      if (severity) {
        params.push(severity);
        sql += ` AND severity = $${params.length}`;
      }
      
      sql += ` ORDER BY 
        CASE severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
        END ASC,
        sla_deadline ASC
      LIMIT $${params.length + 1}`;
      params.push(limit);
      
      const result = await db.query<ContentModerationQueueItem>(sql, params);
      
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
   * Get queue item by ID
   */
  getQueueItemById: async (
    queueItemId: string
  ): Promise<ServiceResult<ContentModerationQueueItem>> => {
    try {
      const result = await db.query<ContentModerationQueueItem>(
        'SELECT * FROM content_moderation_queue WHERE id = $1',
        [queueItemId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Moderation queue item ${queueItemId} not found`,
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
   * Review queue item (admin action)
   */
  reviewQueueItem: async (
    queueItemId: string,
    reviewedBy: string,
    decision: ReviewDecision,
    reviewNotes?: string
  ): Promise<ServiceResult<ContentModerationQueueItem>> => {
    try {
      // Map decision to status
      let status: ModerationStatus;
      if (decision === 'approve') {
        status = 'approved';
      } else if (decision === 'reject') {
        status = 'rejected';
      } else if (decision === 'escalate') {
        status = 'escalated';
      } else {
        status = 'approved'; // 'no_action' treated as approve
      }
      
      const result = await db.query<ContentModerationQueueItem>(
        `UPDATE content_moderation_queue
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_decision = $3,
             review_notes = $4
         WHERE id = $5
         RETURNING *`,
        [status, reviewedBy, decision, reviewNotes || null, queueItemId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Moderation queue item ${queueItemId} not found`,
          },
        };
      }
      
      const queueItem = result.rows[0];
      
      // Take action based on decision
      if (decision === 'approve') {
        // Restore content (if previously hidden)
        await applyModerationAction({
          contentType: queueItem.content_type,
          contentId: queueItem.content_id,
          action: 'approve', // Restore content visibility
        });
      } else if (decision === 'reject') {
        // Hide/quarantine content
        await applyModerationAction({
          contentType: queueItem.content_type,
          contentId: queueItem.content_id,
          action: 'quarantine', // Hide content from users
        });
        
        // Notify user that their content was rejected
        await NotificationService.create({
          userId: queueItem.user_id,
          category: 'security_alert',
          title: 'Content Removed',
          body: `Your ${queueItem.content_type} has been removed after review. ${reviewNotes ? `Reason: ${reviewNotes}` : ''}`,
          deepLink: `app://content/${queueItem.content_id}`,
          taskId: queueItem.content_type === 'task' ? queueItem.content_id : undefined,
          metadata: { queueItemId: queueItem.id, decision, reviewNotes },
          channels: ['in_app', 'push', 'email'],
          priority: 'HIGH',
        }).catch(error => {
          // Log error but don't fail review process
          console.error(`Failed to send rejection notification to user ${queueItem.user_id}:`, error);
        });
      } else if (decision === 'escalate') {
        // Escalate to higher authority (admin review)
        // Content remains in current state until escalated review
        // Notify admin team for escalated review
        // TODO: Get admin user IDs from admin_roles table
        // For now, escalate content remains in queue for admin review via admin dashboard
        console.log(`[Escalated Review] Content ${queueItem.content_type} ${queueItem.content_id} escalated for admin review`);
      }
      
      return {
        success: true,
        data: queueItem,
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
  // USER REPORTING
  // --------------------------------------------------------------------------
  
  /**
   * Create a user report
   * 
   * CONTENT_MODERATION_SPEC.md §4: User reporting system
   */
  createReport: async (
    params: CreateReportParams
  ): Promise<ServiceResult<ContentReport>> => {
    const {
      reporterUserId,
      contentType,
      contentId,
      reportedContentUserId,
      category,
      description,
    } = params;
    
    try {
      // Validate: Cannot report yourself
      if (reporterUserId === reportedContentUserId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Cannot report your own content',
          },
        };
      }
      
      // Create report (schema uses reported_content_user_id, category, description)
      const result = await db.query<ContentReport>(
        `INSERT INTO content_reports (
          reporter_user_id, content_type, content_id, reported_content_user_id,
          category, description, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING *`,
        [
          reporterUserId,
          contentType,
          contentId,
          reportedContentUserId,
          category,
          description || null,
        ]
      );
      
      // Automatically flag content for moderation if report category is high priority
      const highPriorityCategories = ['harassment', 'inappropriate', 'illegal'];
      if (highPriorityCategories.includes(category.toLowerCase())) {
        // Create moderation queue item from user report
        await ContentModerationService.moderateContent({
          contentType,
          contentId,
          userId: reportedContentUserId,
          flaggedBy: 'user_report',
          reporterUserId: reporterUserId,
          aiConfidence: 0.8, // User reports have high confidence
          aiRecommendation: 'flag',
        });
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
   * Get reports for a user (admin view)
   */
  getUserReports: async (
    userId: string,
    status?: ReportStatus,
    limit: number = 100
  ): Promise<ServiceResult<ContentReport[]>> => {
    try {
      let sql = `SELECT * FROM content_reports WHERE reported_content_user_id = $1`;
      const params: unknown[] = [userId];
      
      if (status) {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }
      
      sql += ` ORDER BY reported_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);
      
      const result = await db.query<ContentReport>(sql, params);
      
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
   * Review content report (admin action)
   */
  reviewReport: async (
    reportId: string,
    reviewedBy: string,
    decision: string, // e.g., 'action_taken', 'no_action', 'dismissed'
    reviewNotes?: string
  ): Promise<ServiceResult<ContentReport>> => {
    try {
      let status: ReportStatus;
      if (decision === 'action_taken' || decision === 'no_action') {
        status = 'resolved';
      } else if (decision === 'dismissed') {
        status = 'dismissed';
      } else {
        status = 'reviewed';
      }
      
      const result = await db.query<ContentReport>(
        `UPDATE content_reports
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_decision = $3,
             review_notes = $4
         WHERE id = $5
         RETURNING *`,
        [status, reviewedBy, decision, reviewNotes || null, reportId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Content report ${reportId} not found`,
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
  // APPEALS
  // --------------------------------------------------------------------------
  
  /**
   * Create an appeal for moderated content
   * 
   * CONTENT_MODERATION_SPEC.md §5: Appeal system
   */
  createAppeal: async (
    params: CreateAppealParams
  ): Promise<ServiceResult<ContentAppeal>> => {
    const { userId, moderationQueueId, originalDecision, appealReason, deadline } = params;
    
    try {
      // Schema requires moderation_queue_id and original_decision (no content_report_id field)
      // Create appeal
      const result = await db.query<ContentAppeal>(
        `INSERT INTO content_appeals (
          user_id, moderation_queue_id, original_decision, appeal_reason, status, deadline
        )
        VALUES ($1, $2, $3, $4, 'pending', $5)
        RETURNING *`,
        [userId, moderationQueueId, originalDecision, appealReason, deadline]
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
   * Get appeals for a user
   */
  getUserAppeals: async (
    userId: string,
    status?: AppealStatus,
    limit: number = 50
  ): Promise<ServiceResult<ContentAppeal[]>> => {
    try {
      let sql = `SELECT * FROM content_appeals WHERE user_id = $1`;
      const params: unknown[] = [userId];
      
      if (status) {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }
      
      sql += ` ORDER BY submitted_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);
      
      const result = await db.query<ContentAppeal>(sql, params);
      
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
   * Review appeal (admin action)
   */
  reviewAppeal: async (
    appealId: string,
    reviewedBy: string,
    decision: 'upheld' | 'overturned',
    reviewNotes?: string
  ): Promise<ServiceResult<ContentAppeal>> => {
    try {
      const status: AppealStatus = decision === 'overturned' ? 'overturned' : 'upheld';
      
      const result = await db.query<ContentAppeal>(
        `UPDATE content_appeals
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_decision = $3,
             review_notes = $4
         WHERE id = $5
         RETURNING *`,
        [status, reviewedBy, decision, reviewNotes || null, appealId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Content appeal ${appealId} not found`,
          },
        };
      }
      
      const appeal = result.rows[0];
      
      // If appeal overturned, reverse moderation action (restore content, etc.)
      if (decision === 'overturned') {
        // Get the original moderation queue item to determine content type and ID
        if (appeal.moderation_queue_id) {
          const queueItemResult = await db.query<ContentModerationQueueItem>(
            `SELECT content_type, content_id FROM content_moderation_queue WHERE id = $1`,
            [appeal.moderation_queue_id]
          );
          
          if (queueItemResult.rows.length > 0) {
            const queueItem = queueItemResult.rows[0];
            
            // Reverse the moderation action (restore content visibility)
            await applyModerationAction({
              contentType: queueItem.content_type,
              contentId: queueItem.content_id,
              action: 'approve', // Restore content
            });
            
            // Update the original moderation queue item status to 'approved'
            await db.query(
              `UPDATE content_moderation_queue 
               SET status = 'approved', review_decision = 'approve'
               WHERE id = $1`,
              [appeal.moderation_queue_id]
            );
          }
        }
        
        // Notify user that their appeal was successful
        await NotificationService.create({
          userId: appeal.user_id,
          category: 'security_alert',
          title: 'Appeal Successful',
          body: 'Your appeal has been reviewed and your content has been restored.',
          deepLink: appeal.moderation_queue_id ? `app://moderation/${appeal.moderation_queue_id}` : 'app://profile',
          metadata: { appealId: appeal.id, originalDecision: appeal.original_decision },
          channels: ['in_app', 'push', 'email'],
          priority: 'MEDIUM',
        }).catch(error => {
          // Log error but don't fail appeal process
          console.error(`Failed to send appeal success notification to user ${appeal.user_id}:`, error);
        });
      }
      
      return {
        success: true,
        data: appeal,
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
   * Get pending appeals (for admin review)
   */
  getPendingAppeals: async (
    limit: number = 100
  ): Promise<ServiceResult<ContentAppeal[]>> => {
    try {
      const result = await db.query<ContentAppeal>(
        `SELECT * FROM content_appeals
         WHERE status = 'pending'
         ORDER BY submitted_at ASC
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
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Apply moderation action to content based on content type
 * Updates the appropriate table's moderation_status column
 * 
 * CONTENT_MODERATION_SPEC.md §2.4: Actions taken based on moderation decisions
 */
async function applyModerationAction(params: {
  contentType: ContentType;
  contentId: string;
  action: 'approve' | 'quarantine' | 'delete';
}): Promise<void> {
  const { contentType, contentId, action } = params;
  
  try {
    if (action === 'approve') {
      // Restore content visibility
      if (contentType === 'message') {
        await db.query(
          `UPDATE task_messages 
           SET moderation_status = 'approved'
           WHERE id = $1`,
          [contentId]
        );
      } else if (contentType === 'rating') {
        // For ratings, restore public visibility
        await db.query(
          `UPDATE task_ratings 
           SET is_public = true
           WHERE id = $1`,
          [contentId]
        );
      } else if (contentType === 'photo') {
        // Photo moderation: Update evidence table if photo is evidence, or message table
        await db.query(
          `UPDATE evidence 
           SET moderation_status = 'approved'
           WHERE id = $1`,
          [contentId]
        );
      }
      // Note: Tasks don't have moderation_status in schema (future enhancement)
    } else if (action === 'quarantine') {
      // Hide content from users (quarantine)
      if (contentType === 'message') {
        await db.query(
          `UPDATE task_messages 
           SET moderation_status = 'quarantined'
           WHERE id = $1`,
          [contentId]
        );
      } else if (contentType === 'rating') {
        // For ratings, hide from public view
        await db.query(
          `UPDATE task_ratings 
           SET is_public = false
           WHERE id = $1`,
          [contentId]
        );
      } else if (contentType === 'photo') {
        // Photo moderation: Quarantine evidence
        await db.query(
          `UPDATE evidence 
           SET moderation_status = 'quarantined'
           WHERE id = $1`,
          [contentId]
        );
      }
      // Note: Tasks don't have moderation_status in schema (future enhancement)
    } else if (action === 'delete') {
      // Soft delete content (respect retention policies)
      if (contentType === 'message') {
        // Messages don't have deleted_at, but could add soft-delete support
        // For now, quarantine instead of delete
        await db.query(
          `UPDATE task_messages 
           SET moderation_status = 'quarantined'
           WHERE id = $1`,
          [contentId]
        );
      } else if (contentType === 'photo') {
        // Evidence can be soft-deleted
        await db.query(
          `UPDATE evidence 
           SET deleted_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [contentId]
        );
      }
      // Note: Tasks and ratings should not be deleted, only hidden/quarantined
    }
  } catch (error) {
    // Log error but don't throw - moderation action failure shouldn't break review process
    console.error(`Failed to apply moderation action ${action} to ${contentType} ${contentId}:`, error);
  }
}
