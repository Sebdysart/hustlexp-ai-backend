/**
 * CapabilityProfileService v1.0.0
 * 
 * CONSTITUTIONAL: Core eligibility engine for HustleXP
 * 
 * This service manages worker capability profiles, which determine:
 * - What trades a worker can perform
 * - What risk levels they can handle
 * - Their verification status
 * 
 * @see ARCHITECTURE.md §11.3
 */

import { db } from '../db';
import { logger } from '../logger';
import { TRPCError } from '@trpc/server';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService';

const log = logger.child({ service: 'CapabilityProfileService' });

// ============================================================================
// TYPES
// ============================================================================

export interface CapabilityProfile {
  userId: string;
  trustTier: string;
  riskClearance: string[];
  locationState: string | null;
  locationCity: string | null;
  insuranceValid: boolean;
  insuranceExpiresAt: string | null;
  backgroundCheckValid: boolean;
  backgroundCheckExpiresAt: string | null;
  verifiedTrades: VerifiedTrade[];
  updatedAt: string;
}

export interface VerifiedTrade {
  trade: string;
  state: string;
  expiresAt: string | null;
  licenseVerificationId: string;
}

export interface CapabilitySummary {
  canWork: boolean;
  blockingReasons: string[];
  riskLevels: string[];
  trades: string[];
  states: string[];
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Get capability profile for a user
 * Recomputes if stale or missing
 */
export async function getCapabilityProfile(userId: string): Promise<CapabilityProfile> {
  // First, ensure profile is up to date
  await recomputeCapabilityProfile(userId, { reason: 'getCapabilityProfile' });

  // Load the profile
  const profileResult = await db.query<{
    user_id: string;
    trust_tier: string;
    risk_clearance: string[];
    location_state: string | null;
    location_city: string | null;
    insurance_valid: boolean;
    insurance_expires_at: string | null;
    background_check_valid: boolean;
    background_check_expires_at: string | null;
    updated_at: string;
  }>(
    `
    SELECT
      user_id, trust_tier, risk_clearance, location_state, location_city,
      insurance_valid, insurance_expires_at,
      background_check_valid, background_check_expires_at,
      updated_at
    FROM capability_profiles
    WHERE user_id = $1
    `,
    [userId]
  );

  if (profileResult.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Capability profile not found for user ${userId}`,
    });
  }

  const row = profileResult.rows[0];

  // Load verified trades
  const tradesResult = await db.query<{
    trade: string;
    state: string;
    expires_at: string | null;
    license_verification_id: string;
  }>(
    `
    SELECT trade, state, expires_at, license_verification_id
    FROM verified_trades
    WHERE user_id = $1
    ORDER BY trade, state
    `,
    [userId]
  );

  return {
    userId: row.user_id,
    trustTier: row.trust_tier,
    riskClearance: row.risk_clearance || ['low'],
    locationState: row.location_state,
    locationCity: row.location_city,
    insuranceValid: row.insurance_valid,
    insuranceExpiresAt: row.insurance_expires_at,
    backgroundCheckValid: row.background_check_valid,
    backgroundCheckExpiresAt: row.background_check_expires_at,
    verifiedTrades: tradesResult.rows.map(t => ({
      trade: t.trade,
      state: t.state,
      expiresAt: t.expires_at,
      licenseVerificationId: t.license_verification_id,
    })),
    updatedAt: row.updated_at,
  };
}

/**
 * Get capability summary (lightweight check)
 */
export async function getCapabilitySummary(userId: string): Promise<CapabilitySummary> {
  const profile = await getCapabilityProfile(userId);

  const blockingReasons: string[] = [];

  if (profile.verifiedTrades.length === 0) {
    blockingReasons.push('No verified trades');
  }

  if (!profile.insuranceValid) {
    blockingReasons.push('Insurance not verified');
  }

  // Check for expired trades
  const now = new Date();
  const hasValidTrade = profile.verifiedTrades.some(t => 
    !t.expiresAt || new Date(t.expiresAt) > now
  );
  if (!hasValidTrade) {
    blockingReasons.push('All trades expired');
  }

  return {
    canWork: blockingReasons.length === 0,
    blockingReasons,
    riskLevels: profile.riskClearance,
    trades: [...new Set(profile.verifiedTrades.map(t => t.trade))],
    states: [...new Set(profile.verifiedTrades.map(t => t.state))],
  };
}

/**
 * Check if user has specific capability
 */
export async function hasCapability(
  userId: string,
  trade: string,
  state: string,
  minRiskLevel: string = 'low'
): Promise<boolean> {
  const profile = await getCapabilityProfile(userId);

  // Check risk clearance
  const riskLevels = ['low', 'medium', 'high', 'critical'];
  const userMaxRisk = profile.riskClearance.length > 0 
    ? riskLevels.indexOf(profile.riskClearance[profile.riskClearance.length - 1])
    : -1;
  const requiredRisk = riskLevels.indexOf(minRiskLevel);
  
  if (userMaxRisk < requiredRisk) {
    return false;
  }

  // Check trade verification
  const now = new Date();
  const matchingTrade = profile.verifiedTrades.find(t => 
    t.trade === trade && 
    t.state === state &&
    (!t.expiresAt || new Date(t.expiresAt) > now)
  );

  return !!matchingTrade;
}

/**
 * Get all capabilities for a user (for feed matching)
 */
export async function getUserCapabilities(userId: string): Promise<{
  trades: string[];
  states: string[];
  riskLevels: string[];
  insuranceValid: boolean;
}> {
  const profile = await getCapabilityProfile(userId);

  return {
    trades: [...new Set(profile.verifiedTrades.map(t => t.trade))],
    states: [...new Set(profile.verifiedTrades.map(t => t.state))],
    riskLevels: profile.riskClearance,
    insuranceValid: profile.insuranceValid,
  };
}

/**
 * Trigger recompute of capability profile
 */
export async function recompute(userId: string, reason: string): Promise<void> {
  log.info({ userId, reason }, 'Triggering capability recompute');
  await recomputeCapabilityProfile(userId, { reason });
}

/**
 * Initialize capability profile for new user
 */
export async function initializeProfile(userId: string): Promise<void> {
  log.info({ userId }, 'Initializing capability profile');
  
  await db.query(
    `
    INSERT INTO capability_profiles (
      user_id, trust_tier, risk_clearance, location_state, location_city,
      insurance_valid, insurance_expires_at,
      background_check_valid, background_check_expires_at,
      updated_at
    )
    VALUES ($1, 'D', ARRAY['low'], NULL, NULL, false, NULL, false, NULL, NOW())
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  // Recompute to pick up any existing verifications
  await recomputeCapabilityProfile(userId, { reason: 'initializeProfile' });
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Get capability profiles for multiple users (for admin/ops)
 */
export async function getProfilesBatch(userIds: string[]): Promise<CapabilityProfile[]> {
  const profiles: CapabilityProfile[] = [];
  
  for (const userId of userIds) {
    try {
      const profile = await getCapabilityProfile(userId);
      profiles.push(profile);
    } catch (error) {
      log.warn({ userId, error }, 'Failed to load profile in batch');
    }
  }

  return profiles;
}

/**
 * Find users with specific capability (for task matching)
 */
export async function findUsersWithCapability(
  trade: string,
  state: string,
  limit: number = 100
): Promise<string[]> {
  const now = new Date().toISOString();
  
  const result = await db.query<{ user_id: string }>(
    `
    SELECT DISTINCT vt.user_id
    FROM verified_trades vt
    JOIN capability_profiles cp ON vt.user_id = cp.user_id
    WHERE vt.trade = $1
      AND vt.state = $2
      AND (vt.expires_at IS NULL OR vt.expires_at > $3)
      AND cp.insurance_valid = true
    ORDER BY cp.updated_at DESC
    LIMIT $4
    `,
    [trade, state, now, limit]
  );

  return result.rows.map(r => r.user_id);
}

export default {
  getCapabilityProfile,
  getCapabilitySummary,
  hasCapability,
  getUserCapabilities,
  recompute,
  initializeProfile,
  getProfilesBatch,
  findUsersWithCapability,
};
