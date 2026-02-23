/**
 * BackgroundCheckService v1.0.0
 *
 * Integrates with Checkr API for background checks on workers.
 * Handles candidate creation, report ordering, webhook processing, and status queries.
 *
 * @see migrations/20260222_005_background_checks.sql
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { logger } from '../logger';

const log = logger.child({ service: 'BackgroundCheckService' });

const CHECKR_API_BASE = 'https://api.checkr.com/v1';
const CHECKR_API_KEY = process.env.CHECKR_API_KEY || '';

// ============================================================================
// TYPES
// ============================================================================

export interface BackgroundCheck {
  id: string;
  user_id: string;
  checkr_candidate_id: string | null;
  checkr_report_id: string | null;
  package: string;
  status: string;
  result: string | null;
  completed_at: Date | null;
  webhook_received_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CheckrCandidate {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

interface CheckrReport {
  id: string;
  status: string;
  result: string | null;
  completed_at: string | null;
}

// ============================================================================
// SERVICE
// ============================================================================

export const BackgroundCheckService = {
  /**
   * Initiate a background check for a user.
   * Creates a Checkr candidate and orders a report.
   */
  initiateCheck: async (params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    ssn?: string;
    package?: string;
  }): Promise<ServiceResult<BackgroundCheck>> => {
    const { userId, email, firstName, lastName, dateOfBirth, ssn, package: pkg = 'tasker_standard' } = params;

    if (!CHECKR_API_KEY) {
      return {
        success: false,
        error: { code: 'CHECKR_NOT_CONFIGURED', message: 'Checkr API key not configured' },
      };
    }

    try {
      // Check for existing pending check
      const existing = await db.query<BackgroundCheck>(
        `SELECT * FROM background_checks WHERE user_id = $1 AND status IN ('pending', 'processing') LIMIT 1`,
        [userId]
      );

      if (existing.rows.length > 0) {
        return {
          success: false,
          error: { code: ErrorCodes.INVALID_STATE, message: 'A background check is already in progress' },
        };
      }

      // Step 1: Create candidate in Checkr
      const candidateRes = await fetch(`${CHECKR_API_BASE}/candidates`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(CHECKR_API_KEY + ':').toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          first_name: firstName,
          last_name: lastName,
          dob: dateOfBirth,
          ...(ssn && { ssn }),
        }),
      });

      if (!candidateRes.ok) {
        const errBody = await candidateRes.text();
        log.error({ status: candidateRes.status, body: errBody.slice(0, 500) }, 'Checkr candidate creation failed');
        return {
          success: false,
          error: { code: 'CHECKR_API_ERROR', message: 'Failed to create background check candidate' },
        };
      }

      const candidate: CheckrCandidate = await candidateRes.json() as CheckrCandidate;

      // Step 2: Create report (order the check)
      const reportRes = await fetch(`${CHECKR_API_BASE}/reports`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(CHECKR_API_KEY + ':').toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          candidate_id: candidate.id,
          package: pkg,
        }),
      });

      if (!reportRes.ok) {
        const errBody = await reportRes.text();
        log.error({ status: reportRes.status, body: errBody.slice(0, 500) }, 'Checkr report creation failed');
        return {
          success: false,
          error: { code: 'CHECKR_API_ERROR', message: 'Failed to order background check report' },
        };
      }

      const report: CheckrReport = await reportRes.json() as CheckrReport;

      // Step 3: Store in database
      const result = await db.query<BackgroundCheck>(
        `INSERT INTO background_checks (user_id, checkr_candidate_id, checkr_report_id, package, status)
         VALUES ($1, $2, $3, $4, 'processing')
         RETURNING *`,
        [userId, candidate.id, report.id, pkg]
      );

      log.info({ userId, candidateId: candidate.id, reportId: report.id }, 'Background check initiated');

      return { success: true, data: result.rows[0] };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Background check initiation failed');
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Process a Checkr webhook event
   */
  handleWebhook: async (event: {
    type: string;
    data: { object: { id: string; status?: string; result?: string; completed_at?: string } };
  }): Promise<ServiceResult<{ processed: boolean }>> => {
    try {
      const { type, data } = event;
      const reportId = data.object.id;

      if (type === 'report.completed') {
        const result = await db.query<BackgroundCheck>(
          `UPDATE background_checks
           SET status = 'complete',
               result = $1,
               completed_at = $2,
               webhook_received_at = NOW(),
               updated_at = NOW()
           WHERE checkr_report_id = $3
           RETURNING *`,
          [data.object.result || 'clear', data.object.completed_at || new Date().toISOString(), reportId]
        );

        if (result.rows.length > 0) {
          log.info({ reportId, result: data.object.result, userId: result.rows[0].user_id }, 'Background check completed via webhook');
        }

        return { success: true, data: { processed: true } };
      }

      if (type === 'report.suspended' || type === 'report.disputed') {
        await db.query(
          `UPDATE background_checks
           SET status = $1, webhook_received_at = NOW(), updated_at = NOW()
           WHERE checkr_report_id = $2`,
          [type === 'report.suspended' ? 'suspended' : 'disputed', reportId]
        );

        log.info({ reportId, type }, 'Background check status updated via webhook');
        return { success: true, data: { processed: true } };
      }

      log.info({ type, reportId }, 'Unhandled Checkr webhook type');
      return { success: true, data: { processed: false } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Checkr webhook processing failed');
      return {
        success: false,
        error: { code: 'WEBHOOK_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get background check status for a user
   */
  getStatus: async (userId: string): Promise<ServiceResult<BackgroundCheck | null>> => {
    try {
      const result = await db.query<BackgroundCheck>(
        `SELECT * FROM background_checks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      return { success: true, data: result.rows[0] || null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Check if a user has a cleared background check
   */
  isCleared: async (userId: string): Promise<boolean> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM background_checks
         WHERE user_id = $1 AND status = 'complete' AND result = 'clear'`,
        [userId]
      );
      return parseInt(result.rows[0]?.count || '0', 10) > 0;
    } catch {
      return false;
    }
  },
};
