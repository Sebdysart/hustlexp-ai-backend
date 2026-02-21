/**
 * AuditService — Structured audit logging for compliance and security.
 *
 * Logs user actions to both Pino (structured logs) and the audit_log table.
 * Covers: auth events, task/escrow operations, admin actions, data exports.
 */

import { db } from '../db';
import { logger } from '../logger';

const auditLogger = logger.child({ module: 'audit' });

// ============================================================================
// Types
// ============================================================================

export type AuditAction =
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'USER_UPDATE'
  | 'USER_DELETE'
  | 'TASK_CREATE'
  | 'TASK_UPDATE'
  | 'TASK_DELETE'
  | 'TASK_ACCEPT'
  | 'TASK_COMPLETE'
  | 'ESCROW_FUND'
  | 'ESCROW_RELEASE'
  | 'ESCROW_DISPUTE'
  | 'PAYMENT_CREATE'
  | 'PAYMENT_REFUND'
  | 'ADMIN_ACTION'
  | 'DATA_EXPORT'
  | 'PRIVACY_SETTINGS_CHANGE'
  | 'SUBSCRIPTION_CHANGE';

export interface AuditLogEntry {
  userId: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent?: string;
}

// ============================================================================
// Service
// ============================================================================

export const AuditService = {
  /**
   * Log an audit event to structured logger and database.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    // Always log to structured logger (even if DB write fails)
    auditLogger.info({
      userId: entry.userId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      details: entry.details,
      ipAddress: entry.ipAddress,
    });

    // Store in database for queryability
    try {
      await db.query(
        `INSERT INTO audit_log (
          user_id, action, resource_type, resource_id,
          details, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.userId,
          entry.action,
          entry.resourceType,
          entry.resourceId,
          JSON.stringify(entry.details),
          entry.ipAddress,
          entry.userAgent,
        ]
      );
    } catch (error) {
      // Never let audit logging failures break the application
      auditLogger.error({ error, entry }, 'Failed to write audit log to database');
    }
  },

  /**
   * Retrieve audit history for a user (admin/compliance use).
   */
  async getUserActivity(
    userId: string,
    limit: number = 100
  ): Promise<AuditLogEntry[]> {
    const result = await db.query(
      `SELECT * FROM audit_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows as unknown as AuditLogEntry[];
  },

  /**
   * Retrieve audit history for a resource.
   */
  async getResourceActivity(
    resourceType: string,
    resourceId: string,
    limit: number = 50
  ): Promise<AuditLogEntry[]> {
    const result = await db.query(
      `SELECT * FROM audit_log
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [resourceType, resourceId, limit]
    );
    return result.rows as unknown as AuditLogEntry[];
  },
};
