/**
 * Capability Profile Handler (Phase N2.1 - Read-Only)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/capability.getProfile
 * Purpose: Read-only source of truth for eligibility status
 * Phase: N2.1 (Read-Only Backend Handlers)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. READ-ONLY (NO SIDE EFFECTS):
 *    ✅ Reads from capability_profiles table ONLY
 *    ✅ Optional join to verified_trades (read-only)
 *    ❌ NEVER triggers recompute
 *    ❌ NEVER infers eligibility in code
 *    ❌ NEVER modifies capability profile
 * 
 * 2. SOURCE OF TRUTH:
 *    - capability_profiles table (derived, recomputed externally)
 *    - verified_trades table (read-only join for verified_trades array)
 * 
 * 3. RETURNS (no more, no less):
 *    - trust_tier
 *    - risk_clearance
 *    - verified_trades[]
 *    - expiry_flags (derived from expires_at JSONB)
 * 
 * 4. FORBIDDEN:
 *    ❌ Reading from verification tables directly (use verified_trades join)
 *    ❌ Computing unlocks or eligibility hints
 *    ❌ "Helping frontend" by inferring eligibility
 * 
 * Reference: FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md §Capability Profile
 * Reference: CAPABILITY_PROFILE_SCHEMA_AND_INVARIANTS_LOCKED.md
 */

import { protectedProcedure } from '../../../create-context';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface CapabilityProfileRow {
  user_id: string;
  trust_tier: string; // 'A' | 'B' | 'C' | 'D'
  risk_clearance: string[]; // TEXT[]
  insurance_valid: boolean;
  insurance_expires_at: string | null;
  background_check_valid: boolean;
  background_check_expires_at: string | null;
  expires_at: Record<string, string> | null; // JSONB
}

interface VerifiedTradeRow {
  trade: string;
  state: string;
  expires_at: string | null;
}

export const capabilityGetProfileProcedure = protectedProcedure.query(async ({ ctx }) => {
  const firebaseUid = ctx.user?.uid; // Firebase UID from context

  if (!firebaseUid) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User ID not found in context',
    });
  }

  // PHASE N2.1: Read-only query from capability_profiles
  // No side effects, no recompute triggers, no eligibility computation

  // Step 0: Get database user_id from Firebase UID (read-only lookup)
  const userResult = await db.query<{ id: string }>(
    `
    SELECT id
    FROM users
    WHERE firebase_uid = $1
    LIMIT 1
    `,
    [firebaseUid]
  );

  if (userResult.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'User not found in database',
    });
  }

  const userId = userResult.rows[0].id; // Database UUID

  // Step 1: Get capability profile (source of truth)
  const profileResult = await db.query<CapabilityProfileRow>(
    `
    SELECT 
      user_id,
      trust_tier,
      risk_clearance,
      insurance_valid,
      insurance_expires_at,
      background_check_valid,
      background_check_expires_at,
      expires_at
    FROM capability_profiles
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (profileResult.rows.length === 0) {
    // No profile exists yet - return default/empty state
    // This is valid - profile may not exist until first recompute
    return {
      trustTier: null as null,
      riskClearance: ['low'] as string[],
      verifiedTrades: [] as string[],
      expiryFlags: {
        licenses: [] as Array<{ trade: string; expiresAt: string }>,
        insurance: null as string | null,
        backgroundCheck: null as string | null,
      },
    };
  }

  const profile = profileResult.rows[0];

  // Step 2: Get verified trades (read-only join, no side effects)
  const tradesResult = await db.query<VerifiedTradeRow>(
    `
    SELECT 
      trade,
      state,
      expires_at
    FROM verified_trades
    WHERE user_id = $1
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY trade ASC
    `,
    [userId]
  );

  const verifiedTrades = tradesResult.rows.map(row => row.trade);

  // Step 3: Derive expiry flags from expires_at JSONB (read-only transformation)
  const expiresAt = profile.expires_at || {};
  const licenseExpiries: Array<{ trade: string; expiresAt: string }> = [];

  // Extract license expiry dates from verified_trades (already filtered above)
  for (const tradeRow of tradesResult.rows) {
    if (tradeRow.expires_at) {
      licenseExpiries.push({
        trade: tradeRow.trade,
        expiresAt: tradeRow.expires_at,
      });
    }
  }

  return {
    trustTier: profile.trust_tier as 'A' | 'B' | 'C' | 'D' | null,
    riskClearance: profile.risk_clearance || ['low'],
    verifiedTrades,
    expiryFlags: {
      licenses: licenseExpiries,
      insurance: profile.insurance_expires_at || null,
      backgroundCheck: profile.background_check_expires_at || null,
    },
  };
});
