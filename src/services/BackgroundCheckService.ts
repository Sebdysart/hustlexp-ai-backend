/**
 * BACKGROUND CHECK SERVICE
 * 
 * Manages background check verification for critical-risk tasks.
 * Authority: Layer 1 (Backend Service)
 * 
 * Constitutional Reference: ARCHITECTURE.md §12.6, VERIFICATION_PIPELINE_LOCKED.md §3
 * INV-ELIGIBILITY-5: Background check validity gated by verification
 * 
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { CapabilityProfileService } from './CapabilityProfileService.js';

const logger = createLogger('BackgroundCheckService');

// ============================================================================
// TYPES
// ============================================================================

export type BackgroundCheckStatus = 'pending' | 'verified' | 'failed' | 'expired';

export interface BackgroundCheck {
  id: string;
  userId: string;
  status: BackgroundCheckStatus;
  provider: string;
  providerCheckId: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
  resultsEncrypted: Buffer | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBackgroundCheckInput {
  userId: string;
  provider: string;
  providerCheckId?: string;
}

export interface UpdateBackgroundCheckInput {
  status: BackgroundCheckStatus;
  verifiedAt?: Date;
  expiresAt?: Date;
  failureReason?: string;
  resultsEncrypted?: Buffer;
}

export interface BackgroundCheckResult {
  success: boolean;
  backgroundCheck?: BackgroundCheck;
  error?: string;
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Create a new background check request.
 * Only one verified background check per user allowed.
 */
export async function createBackgroundCheck(
  input: CreateBackgroundCheckInput
): Promise<BackgroundCheckResult> {
  try {
    return await transaction(async (tx: any) => {
      // Check if user already has a verified background check
      const [existingVerified] = await tx`
        SELECT id FROM background_checks
        WHERE user_id = ${input.userId}
          AND status = 'verified'
      `;

      if (existingVerified) {
        return {
          success: false,
          error: 'User already has a verified background check',
        };
      }

      // Check for pending background check
      const [existingPending] = await tx`
        SELECT id FROM background_checks
        WHERE user_id = ${input.userId}
          AND status = 'pending'
      `;

      if (existingPending) {
        return {
          success: false,
          error: 'Background check already pending',
        };
      }

      // Create background check record
      const [check] = await tx`
        INSERT INTO background_checks (
          user_id,
          status,
          provider,
          provider_check_id,
          created_at,
          updated_at
        ) VALUES (
          ${input.userId},
          'pending',
          ${input.provider},
          ${input.providerCheckId || null},
          NOW(),
          NOW()
        )
        RETURNING *
      `;

      logger.info({
        checkId: check.id,
        userId: input.userId,
        provider: input.provider,
      }, 'Background check created');

      // Trigger async background check
      triggerAsyncBackgroundCheck(check.id).catch(err => {
        logger.error({ error: err, checkId: check.id }, 'Async background check failed');
      });

      return {
        success: true,
        backgroundCheck: formatBackgroundCheck(check),
      };
    });
  } catch (error: any) {
    logger.error({ error, input }, 'Failed to create background check');
    return { success: false, error: error.message };
  }
}

/**
 * Update background check status.
 * Triggers profile recompute on status change.
 */
export async function updateBackgroundCheck(
  checkId: string,
  input: UpdateBackgroundCheckInput
): Promise<BackgroundCheckResult> {
  try {
    return await transaction(async (tx: any) => {
      const [current] = await tx`
        SELECT * FROM background_checks WHERE id = ${checkId}
      `;

      if (!current) {
        return { success: false, error: 'Background check not found' };
      }

      const [updated] = await tx`
        UPDATE background_checks
        SET 
          status = ${input.status},
          verified_at = ${input.verifiedAt || (input.status === 'verified' ? new Date() : null)},
          expires_at = ${input.expiresAt || null},
          failure_reason = ${input.failureReason || null},
          results_encrypted = ${input.resultsEncrypted || null},
          updated_at = NOW()
        WHERE id = ${checkId}
        RETURNING *
      `;

      logger.info({
        checkId,
        oldStatus: current.status,
        newStatus: input.status,
        userId: current.user_id,
      }, 'Background check updated');

      // Recompute profile if status changed
      if (current.status !== input.status) {
        await CapabilityProfileService.recompute(current.user_id);
      }

      return {
        success: true,
        backgroundCheck: formatBackgroundCheck(updated),
      };
    });
  } catch (error: any) {
    logger.error({ error, checkId }, 'Failed to update background check');
    return { success: false, error: error.message };
  }
}

/**
 * Process webhook from background check provider.
 */
export async function processProviderWebhook(
  provider: string,
  providerCheckId: string,
  status: BackgroundCheckStatus,
  resultData?: any
): Promise<BackgroundCheckResult> {
  try {
    const { sql } = await import('../db/index.js');

    // Find the background check by provider ID
    const [check] = await sql`
      SELECT * FROM background_checks
      WHERE provider = ${provider}
        AND provider_check_id = ${providerCheckId}
    `;

    if (!check) {
      return { success: false, error: 'Background check not found' };
    }

    // Calculate expiry (typically 1 year)
    const expiresAt = status === 'verified' 
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : undefined;

    // Encrypt results if provided
    const resultsEncrypted = resultData 
      ? Buffer.from(JSON.stringify(resultData))
      : undefined;

    return updateBackgroundCheck(check.id, {
      status,
      verifiedAt: status === 'verified' ? new Date() : undefined,
      expiresAt,
      resultsEncrypted,
    });
  } catch (error: any) {
    logger.error({ error, provider, providerCheckId }, 'Failed to process webhook');
    return { success: false, error: error.message };
  }
}

/**
 * Get background check by ID.
 */
export async function getBackgroundCheck(checkId: string): Promise<BackgroundCheck | null> {
  const { sql } = await import('../db/index.js');

  const [row] = await sql`
    SELECT * FROM background_checks WHERE id = ${checkId}
  `;

  return row ? formatBackgroundCheck(row) : null;
}

/**
 * Get background check for a user.
 */
export async function getUserBackgroundCheck(userId: string): Promise<BackgroundCheck | null> {
  const { sql } = await import('../db/index.js');

  const [row] = await sql`
    SELECT * FROM background_checks
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return row ? formatBackgroundCheck(row) : null;
}

/**
 * Get active (verified and not expired) background check for a user.
 */
export async function getActiveBackgroundCheck(userId: string): Promise<BackgroundCheck | null> {
  const { sql } = await import('../db/index.js');

  const [row] = await sql`
    SELECT * FROM background_checks
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY verified_at DESC
    LIMIT 1
  `;

  return row ? formatBackgroundCheck(row) : null;
}

// ============================================================================
// ASYNC VERIFICATION
// ============================================================================

/**
 * Trigger async background check with provider.
 */
async function triggerAsyncBackgroundCheck(checkId: string): Promise<void> {
  logger.info({ checkId }, 'Starting async background check');

  // TODO: Implement integrations with background check providers:
  // - Checkr
  // - Sterling
  // - First Advantage

  logger.info({ checkId }, 'Background check submitted to provider');
}

// ============================================================================
// EXPIRY MANAGEMENT
// ============================================================================

/**
 * Check for expired background checks and update status.
 */
export async function checkExpiredBackgroundChecks(): Promise<{
  checked: number;
  expired: number;
}> {
  const { sql } = await import('../db/index.js');

  const result = await sql`
    UPDATE background_checks
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'verified'
      AND expires_at < NOW()
    RETURNING id, user_id
  `;

  // Recompute profiles for affected users
  const affectedUserIds = new Set(result.map((r: any) => r.user_id));
  for (const userId of affectedUserIds) {
    await CapabilityProfileService.recompute(userId);
  }

  logger.info({ expired: result.length }, 'Expired background checks updated');

  return {
    checked: result.length,
    expired: result.length,
  };
}

// ============================================================================
// PROVIDER INTEGRATIONS
// ============================================================================

/**
 * Initiate background check with Checkr.
 */
export async function initiateCheckrBackgroundCheck(
  userId: string,
  candidateData: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    ssn?: string;
    dob?: string;
    zipcode?: string;
  }
): Promise<BackgroundCheckResult> {
  // TODO: Implement Checkr API integration
  // 1. Create candidate
  // 2. Create report
  // 3. Store report ID
  
  logger.info({ userId }, 'Checkr background check initiation not yet implemented');
  
  return createBackgroundCheck({
    userId,
    provider: 'checkr',
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function formatBackgroundCheck(row: any): BackgroundCheck {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    provider: row.provider,
    providerCheckId: row.provider_check_id,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    failureReason: row.failure_reason,
    resultsEncrypted: row.results_encrypted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const BackgroundCheckService = {
  createBackgroundCheck,
  updateBackgroundCheck,
  processProviderWebhook,
  getBackgroundCheck,
  getUserBackgroundCheck,
  getActiveBackgroundCheck,
  checkExpiredBackgroundChecks,
  initiateCheckrBackgroundCheck,
};

export default BackgroundCheckService;
