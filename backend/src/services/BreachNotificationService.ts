/**
 * BreachNotificationService v1.0.0
 *
 * CONSTITUTIONAL: GDPR Article 33 & 34, GDPR_COMPLIANCE_SPEC.md
 *
 * Implements GDPR breach notification: reporting, tracking, authority/user notification.
 * Core Principle: Breaches must be reported to supervisory authority within 72 hours.
 *
 * CRITICAL: Legal requirement. Non-negotiable.
 *
 * @see GDPR Article 33 (Notification to supervisory authority)
 * @see GDPR Article 34 (Communication to data subject)
 *
 * -- Migration SQL (breach_notifications table):
 * --
 * -- CREATE TABLE IF NOT EXISTS breach_notifications (
 * --   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 * --   reported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 * --   severity      VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
 * --   description   TEXT NOT NULL,
 * --   affected_users_count INTEGER NOT NULL DEFAULT 0,
 * --   data_types_affected  TEXT[] NOT NULL DEFAULT '{}',
 * --   authority_notified_at TIMESTAMPTZ,
 * --   users_notified_at     TIMESTAMPTZ,
 * --   status        VARCHAR(30) NOT NULL DEFAULT 'reported'
 * --                 CHECK (status IN ('reported', 'investigating', 'authority_notified',
 * --                                   'users_notified', 'resolved', 'closed')),
 * --   reporter_id   UUID NOT NULL REFERENCES users(id),
 * --   deadline      TIMESTAMPTZ NOT NULL,
 * --   created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 * --   updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * -- );
 * --
 * -- CREATE INDEX idx_breach_notifications_status ON breach_notifications(status);
 * -- CREATE INDEX idx_breach_notifications_severity ON breach_notifications(severity);
 * -- CREATE INDEX idx_breach_notifications_deadline ON breach_notifications(deadline);
 * -- CREATE INDEX idx_breach_notifications_reporter ON breach_notifications(reporter_id);
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { logger } from '../logger';

const log = logger.child({ service: 'BreachNotificationService' });

// ============================================================================
// TYPES
// ============================================================================

export type BreachSeverity = 'low' | 'medium' | 'high' | 'critical';

export type BreachStatus =
  | 'reported'
  | 'investigating'
  | 'authority_notified'
  | 'users_notified'
  | 'resolved'
  | 'closed';

export interface BreachNotification {
  id: string;
  reported_at: Date;
  severity: BreachSeverity;
  description: string;
  affected_users_count: number;
  data_types_affected: string[];
  authority_notified_at: Date | null;
  users_notified_at: Date | null;
  status: BreachStatus;
  reporter_id: string;
  deadline: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ReportBreachParams {
  severity: BreachSeverity;
  description: string;
  affectedUsersCount: number;
  dataTypesAffected: string[];
  reporterId: string;
}

export interface DeadlineStatus {
  breachId: string;
  deadline: Date;
  reportedAt: Date;
  hoursElapsed: number;
  hoursRemaining: number;
  isOverdue: boolean;
  isApproaching: boolean;
  authorityNotified: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** GDPR Article 33 requires notification within 72 hours */
const BREACH_DEADLINE_HOURS = 72;

/** Warn when fewer than 12 hours remain */
const DEADLINE_WARNING_HOURS = 12;

// ============================================================================
// SERVICE
// ============================================================================

export const BreachNotificationService = {
  // --------------------------------------------------------------------------
  // BREACH REPORTING
  // --------------------------------------------------------------------------

  /**
   * Report a new data breach.
   *
   * GDPR Article 33(1): The controller shall notify the supervisory authority
   * without undue delay and, where feasible, not later than 72 hours.
   */
  reportBreach: async (
    params: ReportBreachParams
  ): Promise<ServiceResult<BreachNotification>> => {
    const { severity, description, affectedUsersCount, dataTypesAffected, reporterId } = params;

    try {
      // Validate severity
      const validSeverities: BreachSeverity[] = ['low', 'medium', 'high', 'critical'];
      if (!validSeverities.includes(severity)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: `Invalid severity: ${severity}. Must be one of: ${validSeverities.join(', ')}`,
          },
        };
      }

      if (!description || description.trim().length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Breach description is required',
          },
        };
      }

      if (affectedUsersCount < 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Affected users count cannot be negative',
          },
        };
      }

      // Calculate 72-hour deadline from now
      const now = new Date();
      const deadline = new Date(now.getTime() + BREACH_DEADLINE_HOURS * 60 * 60 * 1000);

      const result = await db.query<BreachNotification>(
        `INSERT INTO breach_notifications (
          severity, description, affected_users_count, data_types_affected,
          reporter_id, deadline, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'reported')
        RETURNING *`,
        [
          severity,
          description.trim(),
          affectedUsersCount,
          dataTypesAffected,
          reporterId,
          deadline,
        ]
      );

      const breach = result.rows[0];

      log.warn(
        {
          breachId: breach.id,
          severity,
          affectedUsersCount,
          dataTypesAffected,
          reporterId,
          deadline: deadline.toISOString(),
        },
        'Data breach reported — 72-hour notification deadline started'
      );

      return {
        success: true,
        data: breach,
      };
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), severity, reporterId },
        'Failed to report breach'
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
  // BREACH STATUS
  // --------------------------------------------------------------------------

  /**
   * Get the current status of a breach report by ID.
   */
  getBreachStatus: async (
    breachId: string
  ): Promise<ServiceResult<BreachNotification>> => {
    try {
      const result = await db.query<BreachNotification>(
        `SELECT * FROM breach_notifications WHERE id = $1`,
        [breachId]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Breach notification ${breachId} not found`,
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
  // LIST BREACHES
  // --------------------------------------------------------------------------

  /**
   * List all breach notifications, ordered by most recent first.
   */
  listBreaches: async (): Promise<ServiceResult<BreachNotification[]>> => {
    try {
      const result = await db.query<BreachNotification>(
        `SELECT * FROM breach_notifications ORDER BY reported_at DESC`
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

  // --------------------------------------------------------------------------
  // AUTHORITY NOTIFICATION (GDPR Article 33)
  // --------------------------------------------------------------------------

  /**
   * Mark that the supervisory authority has been notified for a breach.
   *
   * GDPR Article 33(1): Notification to the supervisory authority shall contain
   * at minimum the nature of the breach, categories/approximate number of data
   * subjects concerned, likely consequences, and measures taken/proposed.
   */
  notifyAuthority: async (
    breachId: string
  ): Promise<ServiceResult<BreachNotification>> => {
    try {
      // Verify breach exists and has not already been authority-notified
      const existing = await db.query<BreachNotification>(
        `SELECT * FROM breach_notifications WHERE id = $1`,
        [breachId]
      );

      if (existing.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Breach notification ${breachId} not found`,
          },
        };
      }

      const breach = existing.rows[0];

      if (breach.authority_notified_at !== null) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Authority was already notified for breach ${breachId} at ${breach.authority_notified_at}`,
          },
        };
      }

      if (breach.status === 'closed') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot notify authority for a closed breach`,
          },
        };
      }

      const result = await db.query<BreachNotification>(
        `UPDATE breach_notifications
         SET authority_notified_at = NOW(),
             status = 'authority_notified',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [breachId]
      );

      log.info(
        { breachId, severity: breach.severity, affectedUsersCount: breach.affected_users_count },
        'Supervisory authority notified of data breach (GDPR Art. 33)'
      );

      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), breachId },
        'Failed to record authority notification'
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
  // USER NOTIFICATION (GDPR Article 34)
  // --------------------------------------------------------------------------

  /**
   * Mark that affected users have been notified of the breach.
   *
   * GDPR Article 34(1): When the breach is likely to result in a high risk
   * to the rights and freedoms of natural persons, the controller shall
   * communicate the breach to the data subject without undue delay.
   */
  notifyAffectedUsers: async (
    breachId: string
  ): Promise<ServiceResult<BreachNotification>> => {
    try {
      // Verify breach exists
      const existing = await db.query<BreachNotification>(
        `SELECT * FROM breach_notifications WHERE id = $1`,
        [breachId]
      );

      if (existing.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Breach notification ${breachId} not found`,
          },
        };
      }

      const breach = existing.rows[0];

      if (breach.users_notified_at !== null) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Affected users were already notified for breach ${breachId} at ${breach.users_notified_at}`,
          },
        };
      }

      if (breach.status === 'closed') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot notify users for a closed breach`,
          },
        };
      }

      const result = await db.query<BreachNotification>(
        `UPDATE breach_notifications
         SET users_notified_at = NOW(),
             status = 'users_notified',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [breachId]
      );

      log.info(
        {
          breachId,
          severity: breach.severity,
          affectedUsersCount: breach.affected_users_count,
          dataTypesAffected: breach.data_types_affected,
        },
        'Affected users notified of data breach (GDPR Art. 34)'
      );

      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), breachId },
        'Failed to record user notification'
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
  // DEADLINE TRACKING
  // --------------------------------------------------------------------------

  /**
   * Check deadline status for a breach.
   *
   * Returns information about the 72-hour GDPR Article 33 deadline:
   * - Hours elapsed since report
   * - Hours remaining until deadline
   * - Whether deadline is overdue
   * - Whether deadline is approaching (< 12 hours remaining)
   * - Whether authority has been notified
   */
  getDeadlineStatus: async (
    breachId: string
  ): Promise<ServiceResult<DeadlineStatus>> => {
    try {
      const result = await db.query<BreachNotification>(
        `SELECT * FROM breach_notifications WHERE id = $1`,
        [breachId]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Breach notification ${breachId} not found`,
          },
        };
      }

      const breach = result.rows[0];
      const now = new Date();
      const reportedAt = new Date(breach.reported_at);
      const deadline = new Date(breach.deadline);

      const elapsedMs = now.getTime() - reportedAt.getTime();
      const remainingMs = deadline.getTime() - now.getTime();

      const hoursElapsed = Math.round((elapsedMs / (1000 * 60 * 60)) * 100) / 100;
      const hoursRemaining = Math.round((remainingMs / (1000 * 60 * 60)) * 100) / 100;

      const isOverdue = remainingMs <= 0;
      const isApproaching = !isOverdue && hoursRemaining <= DEADLINE_WARNING_HOURS;
      const authorityNotified = breach.authority_notified_at !== null;

      const deadlineStatus: DeadlineStatus = {
        breachId: breach.id,
        deadline,
        reportedAt,
        hoursElapsed,
        hoursRemaining: isOverdue ? 0 : hoursRemaining,
        isOverdue,
        isApproaching,
        authorityNotified,
      };

      // Log warnings for critical deadline situations
      if (isOverdue && !authorityNotified) {
        log.error(
          { breachId, hoursElapsed, severity: breach.severity },
          'GDPR VIOLATION RISK: 72-hour breach notification deadline EXCEEDED without authority notification'
        );
      } else if (isApproaching && !authorityNotified) {
        log.warn(
          { breachId, hoursRemaining, severity: breach.severity },
          'GDPR deadline approaching: fewer than 12 hours remain to notify authority'
        );
      }

      return {
        success: true,
        data: deadlineStatus,
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
