/**
 * CAPABILITY PROFILE SERVICE
 * 
 * Core eligibility engine for HustleXP. Derives capability profiles from
 * verification records. Never mutated directly — always recomputed.
 * 
 * Authority: Layer 1 (Backend Service)
 * Constitutional Reference: ARCHITECTURE.md §11, CAPABILITY_PROFILE_SCHEMA_AND_INVARIANTS_LOCKED.md
 * 
 * INVARIANTS:
 *   - Profile is always derived from source records (license_verifications, insurance_verifications, background_checks, users.trust_tier)
 *   - No direct UPDATE on capability_profiles (except updated_at timestamp)
 *   - Recompute is atomic with source record changes
 * 
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CapabilityProfileService');

// ============================================================================
// TYPES
// ============================================================================

export type TrustTier = 1 | 2 | 3 | 4 | 5;
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CapabilityProfile {
  userId: string;
  profileId: string;
  trustTier: TrustTier;
  trustTierUpdatedAt: Date;
  riskClearance: RiskLevel[];
  insuranceValid: boolean;
  insuranceExpiresAt: Date | null;
  backgroundCheckValid: boolean;
  backgroundCheckExpiresAt: Date | null;
  locationState: string;
  locationCity: string | null;
  willingnessFlags: {
    inHomeWork: boolean;
    highRiskTasks: boolean;
    urgentJobs: boolean;
  };
  verificationStatus: Record<string, any>;
  expiresAt: Record<string, any>;
  derivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerifiedTrade {
  trade: string;
  state: string;
  licenseVerificationId: string;
  verifiedAt: Date;
  expiresAt: Date | null;
  verificationMethod: string;
}

export interface RecomputeResult {
  success: boolean;
  profileId?: string;
  riskClearance?: RiskLevel[];
  verifiedTrades?: VerifiedTrade[];
  insuranceValid?: boolean;
  backgroundCheckValid?: boolean;
  error?: string;
}

export interface LicenseVerificationRecord {
  id: string;
  trade: string;
  state: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verifiedAt: Date | null;
  expiresAt: Date | null;
  verificationMethod: string;
}

export interface InsuranceVerificationRecord {
  id: string;
  trade: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verifiedAt: Date | null;
  expiresAt: Date | null;
  coverageAmount: number;
}

export interface BackgroundCheckRecord {
  id: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verifiedAt: Date | null;
  expiresAt: Date | null;
  provider: string;
}

// ============================================================================
// RISK CLEARANCE MAPPING (INV-ELIGIBILITY-1)
// ============================================================================

/**
 * Trust tier → risk clearance mapping (constitutional)
 * Tier 1 (ROOKIE) = low only
 * Tier 2-3 (VERIFIED/TRUSTED) = low+medium
 * Tier 4 (ELITE) = low+medium+high
 * Tier 5 (MASTER) = all (low+medium+high+critical)
 */
const TRUST_TIER_RISK_CLEARANCE: Record<TrustTier, RiskLevel[]> = {
  1: ['low'],
  2: ['low', 'medium'],
  3: ['low', 'medium'],
  4: ['low', 'medium', 'high'],
  5: ['low', 'medium', 'high', 'critical'],
};

/**
 * Get risk clearance for a trust tier (pure function)
 */
export function getRiskClearanceForTier(tier: TrustTier): RiskLevel[] {
  return TRUST_TIER_RISK_CLEARANCE[tier] || ['low'];
}

// ============================================================================
// ROW TYPES
// ============================================================================

interface LicenseVerificationDbRow {
  id: string;
  trade: string;
  state: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verified_at: Date | null;
  expires_at: Date | null;
  verification_method: string;
}

interface InsuranceVerificationDbRow {
  id: string;
  trade: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verified_at: Date | null;
  expires_at: Date | null;
  coverage_amount: number;
}

interface BackgroundCheckDbRow {
  id: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  verified_at: Date | null;
  expires_at: Date | null;
  provider: string;
}

interface VerifiedTradeDbRow {
  trade: string;
  state: string;
  license_verification_id: string;
  verified_at: Date;
  expires_at: Date | null;
  verification_method: string;
}

// ============================================================================
// SOURCE RECORD FETCHING
// ============================================================================

/**
 * Fetch active license verifications for a user
 */
async function fetchLicenseVerifications(
  tx: any,
  userId: string
): Promise<LicenseVerificationRecord[]> {
  const rows = await tx`
    SELECT 
      id,
      trade,
      state,
      status,
      verified_at,
      expires_at,
      verification_method
    FROM license_verifications
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY trade, state
  `;

  return rows.map((row: LicenseVerificationDbRow) => ({
    id: row.id,
    trade: row.trade,
    state: row.state,
    status: row.status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    verificationMethod: row.verification_method,
  }));
}

/**
 * Fetch insurance verifications for a user
 */
async function fetchInsuranceVerifications(
  tx: any,
  userId: string
): Promise<InsuranceVerificationRecord[]> {
  const rows = await tx`
    SELECT 
      id,
      trade,
      status,
      verified_at,
      expires_at,
      coverage_amount
    FROM insurance_verifications
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY trade
  `;

  return rows.map((row: InsuranceVerificationDbRow) => ({
    id: row.id,
    trade: row.trade,
    status: row.status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    coverageAmount: row.coverage_amount,
  }));
}

/**
 * Fetch background check for a user
 */
async function fetchBackgroundCheck(
  tx: any,
  userId: string
): Promise<BackgroundCheckRecord | null> {
  const [row] = await tx`
    SELECT 
      id,
      status,
      verified_at,
      expires_at,
      provider
    FROM background_checks
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY verified_at DESC
    LIMIT 1
  `;

  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    provider: row.provider,
  };
}

/**
 * Fetch user's trust tier and location from users table
 */
async function fetchUserCoreData(
  tx: any,
  userId: string
): Promise<{ trustTier: TrustTier; locationState: string; locationCity: string | null } | null> {
  const [row] = await tx`
    SELECT 
      trust_tier,
      location_state,
      location_city
    FROM users
    WHERE id = ${userId}
  `;

  if (!row) return null;

  return {
    trustTier: row.trust_tier || 1,
    locationState: row.location_state || 'WA', // Default fallback
    locationCity: row.location_city,
  };
}

/**
 * Fetch user's willingness flags from capability_claims
 */
async function fetchWillingnessFlags(
  tx: any,
  userId: string
): Promise<{ inHomeWork: boolean; highRiskTasks: boolean; urgentJobs: boolean }> {
  const [row] = await tx`
    SELECT risk_preferences
    FROM capability_claims
    WHERE user_id = ${userId}
  `;

  if (!row?.risk_preferences) {
    return {
      inHomeWork: false,
      highRiskTasks: false,
      urgentJobs: false,
    };
  }

  return {
    inHomeWork: row.risk_preferences.in_home_work || false,
    highRiskTasks: row.risk_preferences.high_risk_tasks || false,
    urgentJobs: row.risk_preferences.urgent_jobs || false,
  };
}

// ============================================================================
// CORE RECOMPUTE FUNCTION
// ============================================================================

/**
 * Recompute capability profile for a user.
 * 
 * This is the ONLY way to update a capability profile. It:
 * 1. Reads all source records (license_verifications, insurance_verifications, background_checks, users.trust_tier)
 * 2. Derives the new capability profile
 * 3. Updates capability_profiles atomically
 * 4. Syncs verified_trades join table
 * 5. Invalidates feed cache
 * 
 * Must be called within a transaction when source records change.
 */
export async function recompute(userId: string): Promise<RecomputeResult> {
  try {
    return await transaction(async (tx: any) => {
      logger.info({ userId }, 'Starting capability profile recompute');

      // Step 1: Fetch all source records
      const [
        userCore,
        licenseVerifications,
        insuranceVerifications,
        backgroundCheck,
        willingnessFlags,
      ] = await Promise.all([
        fetchUserCoreData(tx, userId),
        fetchLicenseVerifications(tx, userId),
        fetchInsuranceVerifications(tx, userId),
        fetchBackgroundCheck(tx, userId),
        fetchWillingnessFlags(tx, userId),
      ]);

      if (!userCore) {
        return {
          success: false,
          error: `User not found: ${userId}`,
        };
      }

      // Step 2: Calculate derived values
      const riskClearance = getRiskClearanceForTier(userCore.trustTier);
      
      // Insurance is valid if ANY trade has valid insurance
      const insuranceValid = insuranceVerifications.length > 0;
      const insuranceExpiresAt = insuranceVerifications.length > 0
        ? insuranceVerifications.reduce((earliest: Date | null, iv) => {
            if (!iv.expiresAt) return earliest;
            if (!earliest) return iv.expiresAt;
            return iv.expiresAt < earliest ? iv.expiresAt : earliest;
          }, null)
        : null;

      // Background check validity
      const backgroundCheckValid = backgroundCheck !== null;
      const backgroundCheckExpiresAt = backgroundCheck?.expiresAt || null;

      // Step 3: Upsert capability profile
      const [profile] = await tx`
        INSERT INTO capability_profiles (
          user_id,
          trust_tier,
          trust_tier_updated_at,
          risk_clearance,
          insurance_valid,
          insurance_expires_at,
          background_check_valid,
          background_check_expires_at,
          location_state,
          location_city,
          willingness_flags,
          verification_status,
          expires_at,
          derived_at,
          updated_at
        ) VALUES (
          ${userId},
          ${userCore.trustTier},
          NOW(),
          ${riskClearance},
          ${insuranceValid},
          ${insuranceExpiresAt},
          ${backgroundCheckValid},
          ${backgroundCheckExpiresAt},
          ${userCore.locationState},
          ${userCore.locationCity},
          ${JSON.stringify(willingnessFlags)},
          ${JSON.stringify({
            licenses: licenseVerifications.length,
            insurance: insuranceVerifications.length,
            backgroundCheck: backgroundCheckValid,
          })},
          ${JSON.stringify({
            insurance: insuranceExpiresAt,
            backgroundCheck: backgroundCheckExpiresAt,
          })},
          NOW(),
          NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          trust_tier = EXCLUDED.trust_tier,
          trust_tier_updated_at = EXCLUDED.trust_tier_updated_at,
          risk_clearance = EXCLUDED.risk_clearance,
          insurance_valid = EXCLUDED.insurance_valid,
          insurance_expires_at = EXCLUDED.insurance_expires_at,
          background_check_valid = EXCLUDED.background_check_valid,
          background_check_expires_at = EXCLUDED.background_check_expires_at,
          location_state = EXCLUDED.location_state,
          location_city = EXCLUDED.location_city,
          willingness_flags = EXCLUDED.willingness_flags,
          verification_status = EXCLUDED.verification_status,
          expires_at = EXCLUDED.expires_at,
          derived_at = EXCLUDED.derived_at,
          updated_at = EXCLUDED.updated_at
        RETURNING profile_id
      `;

      const profileId = profile.profile_id;

      // Step 4: Sync verified_trades join table
      // First, delete existing trades that are no longer valid
      const validLicenseIds = licenseVerifications.map(lv => lv.id);
      
      if (validLicenseIds.length > 0) {
        await tx`
          DELETE FROM verified_trades
          WHERE user_id = ${userId}
            AND license_verification_id NOT IN (${tx(validLicenseIds)})
        `;
      } else {
        await tx`
          DELETE FROM verified_trades
          WHERE user_id = ${userId}
        `;
      }

      // Insert/update current verified trades
      for (const lv of licenseVerifications) {
        await tx`
          INSERT INTO verified_trades (
            profile_id,
            user_id,
            trade,
            state,
            license_verification_id,
            verified_at,
            expires_at,
            verification_method
          ) VALUES (
            ${profileId},
            ${userId},
            ${lv.trade},
            ${lv.state},
            ${lv.id},
            ${lv.verifiedAt},
            ${lv.expiresAt},
            ${lv.verificationMethod || 'license_scan'}
          )
          ON CONFLICT (profile_id, trade) DO UPDATE SET
            state = EXCLUDED.state,
            license_verification_id = EXCLUDED.license_verification_id,
            verified_at = EXCLUDED.verified_at,
            expires_at = EXCLUDED.expires_at,
            verification_method = EXCLUDED.verification_method
        `;
      }

      // Step 5: Invalidate feed cache (async, don't block)
      invalidateFeedCache(userId).catch(err => {
        logger.warn({ error: err, userId }, 'Failed to invalidate feed cache');
      });

      logger.info({
        userId,
        profileId,
        trustTier: userCore.trustTier,
        riskClearance,
        verifiedTrades: licenseVerifications.length,
        insuranceValid,
        backgroundCheckValid,
      }, 'Capability profile recomputed successfully');

      return {
        success: true,
        profileId,
        riskClearance,
        verifiedTrades: licenseVerifications.map(lv => ({
          trade: lv.trade,
          state: lv.state,
          licenseVerificationId: lv.id,
          verifiedAt: lv.verifiedAt!,
          expiresAt: lv.expiresAt,
          verificationMethod: lv.verificationMethod || 'license_scan',
        })),
        insuranceValid,
        backgroundCheckValid,
      };
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, userId }, 'Failed to recompute capability profile');
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Invalidate feed cache for a user.
 * Called after profile recompute to ensure feed reflects new eligibility.
 */
async function invalidateFeedCache(userId: string): Promise<void> {
  // TODO: Implement cache invalidation with Redis/Upstash
  // For now, just log the intent
  logger.info({ userId }, 'Feed cache invalidation requested');
}

// ============================================================================
// PROFILE QUERY FUNCTIONS
// ============================================================================

/**
 * Get capability profile for a user
 */
export async function getProfile(userId: string): Promise<CapabilityProfile | null> {
  const { sql } = await import('../db/index.js');
  
  const [row] = await sql`
    SELECT 
      user_id,
      profile_id,
      trust_tier,
      trust_tier_updated_at,
      risk_clearance,
      insurance_valid,
      insurance_expires_at,
      background_check_valid,
      background_check_expires_at,
      location_state,
      location_city,
      willingness_flags,
      verification_status,
      expires_at,
      derived_at,
      created_at,
      updated_at
    FROM capability_profiles
    WHERE user_id = ${userId}
  `;

  if (!row) return null;

  return {
    userId: row.user_id,
    profileId: row.profile_id,
    trustTier: row.trust_tier,
    trustTierUpdatedAt: row.trust_tier_updated_at,
    riskClearance: row.risk_clearance,
    insuranceValid: row.insurance_valid,
    insuranceExpiresAt: row.insurance_expires_at,
    backgroundCheckValid: row.background_check_valid,
    backgroundCheckExpiresAt: row.background_check_expires_at,
    locationState: row.location_state,
    locationCity: row.location_city,
    willingnessFlags: row.willingness_flags,
    verificationStatus: row.verification_status,
    expiresAt: row.expires_at,
    derivedAt: row.derived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get verified trades for a user
 */
export async function getVerifiedTrades(userId: string): Promise<VerifiedTrade[]> {
  const { sql } = await import('../db/index.js');
  
  const rows = await sql`
    SELECT 
      trade,
      state,
      license_verification_id,
      verified_at,
      expires_at,
      verification_method
    FROM verified_trades
    WHERE user_id = ${userId}
    ORDER BY trade
  `;

  return rows.map((row: VerifiedTradeDbRow) => ({
    trade: row.trade,
    state: row.state,
    licenseVerificationId: row.license_verification_id,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    verificationMethod: row.verification_method,
  }));
}

// ============================================================================
// EXPIRY CHECKING
// ============================================================================

/**
 * Check for expired credentials and recompute affected profiles.
 * Should be called by a scheduled job (e.g., daily).
 */
export async function checkExpiredCredentials(): Promise<{
  checked: number;
  expired: number;
  recomputed: number;
}> {
  const { sql } = await import('../db/index.js');
  
  logger.info('Starting expired credentials check');

  // Find users with expired licenses
  const expiredLicenses = await sql`
    SELECT DISTINCT user_id
    FROM license_verifications
    WHERE status = 'verified'
      AND expires_at < NOW()
  `;

  // Find users with expired insurance
  const expiredInsurance = await sql`
    SELECT DISTINCT user_id
    FROM insurance_verifications
    WHERE status = 'verified'
      AND expires_at < NOW()
  `;

  // Find users with expired background checks
  const expiredBackgroundChecks = await sql`
    SELECT DISTINCT user_id
    FROM background_checks
    WHERE status = 'verified'
      AND expires_at < NOW()
  `;

  // Combine unique user IDs
  const userIds = new Set([
    ...expiredLicenses.map((r: any) => r.user_id),
    ...expiredInsurance.map((r: any) => r.user_id),
    ...expiredBackgroundChecks.map((r: any) => r.user_id),
  ]);

  let recomputed = 0;

  for (const userId of userIds) {
    // Update expired records to 'expired' status
    await sql`
      UPDATE license_verifications
      SET status = 'expired', updated_at = NOW()
      WHERE user_id = ${userId}
        AND status = 'verified'
        AND expires_at < NOW()
    `;

    await sql`
      UPDATE insurance_verifications
      SET status = 'expired', updated_at = NOW()
      WHERE user_id = ${userId}
        AND status = 'verified'
        AND expires_at < NOW()
    `;

    await sql`
      UPDATE background_checks
      SET status = 'expired', updated_at = NOW()
      WHERE user_id = ${userId}
        AND status = 'verified'
        AND expires_at < NOW()
    `;

    // Recompute profile
    const result = await recompute(userId);
    if (result.success) {
      recomputed++;
    }
  }

  logger.info({
    checked: expiredLicenses.length + expiredInsurance.length + expiredBackgroundChecks.length,
    expired: userIds.size,
    recomputed,
  }, 'Expired credentials check complete');

  return {
    checked: expiredLicenses.length + expiredInsurance.length + expiredBackgroundChecks.length,
    expired: userIds.size,
    recomputed,
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const CapabilityProfileService = {
  recompute,
  getProfile,
  getVerifiedTrades,
  getRiskClearanceForTier,
  checkExpiredCredentials,
};

export default CapabilityProfileService;
