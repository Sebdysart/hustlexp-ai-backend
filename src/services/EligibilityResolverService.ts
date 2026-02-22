/**
 * ELIGIBILITY RESOLVER SERVICE
 * 
 * Pure functions for determining task eligibility. No side effects.
 * Used by FeedQueryService and apply endpoint for defense-in-depth.
 * 
 * Authority: Layer 1 (Backend Service)
 * Constitutional Reference: ARCHITECTURE.md §13, FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 * 
 * CORE RULE: If a task appears in a user's feed, the user is eligible to accept it.
 * There are no exceptions, warnings, disabled buttons, or soft blocks.
 * 
 * @version 1.0.0
 */

import type { CapabilityProfile, TrustTier, RiskLevel, VerifiedTrade } from './CapabilityProfileService.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskRequirements {
  taskId: string;
  locationState: string;
  riskLevel: RiskLevel;
  requiredTrade: string | null;
  requiredTrustTier: TrustTier;
  insuranceRequired: boolean;
  backgroundCheckRequired: boolean;
  status: string;
}

export interface EligibilityCheck {
  eligible: boolean;
  reasons: string[];
  checks: {
    locationMatch: boolean;
    riskClearance: boolean;
    tradeVerified: boolean;
    trustTier: boolean;
    insurance: boolean;
    backgroundCheck: boolean;
    taskOpen: boolean;
  };
}

export interface EligibilityFactors {
  userId: string;
  taskId: string;
  profile: CapabilityProfile;
  verifiedTrades: VerifiedTrade[];
  task: TaskRequirements;
}

// ============================================================================
// PURE ELIGIBILITY FUNCTIONS
// ============================================================================

/**
 * Check if user's location state matches task location state.
 * Pure function - no side effects.
 */
export function checkLocationMatch(
  userState: string,
  taskState: string
): boolean {
  return userState === taskState;
}

/**
 * Check if user's risk clearance allows task's risk level.
 * Pure function - no side effects.
 * 
 * Risk clearance hierarchy: low < medium < high < critical
 */
export function checkRiskClearance(
  userRiskClearance: RiskLevel[],
  taskRiskLevel: RiskLevel
): boolean {
  const riskHierarchy: Record<RiskLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  const taskRiskValue = riskHierarchy[taskRiskLevel];
  
  // User can access tasks at or below their clearance level
  return userRiskClearance.some(clearance => 
    riskHierarchy[clearance] >= taskRiskValue
  );
}

/**
 * Check if user has verified trade required by task.
 * Pure function - no side effects.
 */
export function checkTradeVerified(
  verifiedTrades: VerifiedTrade[],
  requiredTrade: string | null
): boolean {
  // No trade required = eligible
  if (!requiredTrade) return true;
  
  // Check if user has the required trade verified
  return verifiedTrades.some(vt => 
    vt.trade.toLowerCase() === requiredTrade.toLowerCase()
  );
}

/**
 * Check if user's trust tier meets task requirement.
 * Pure function - no side effects.
 */
export function checkTrustTier(
  userTrustTier: TrustTier,
  requiredTrustTier: TrustTier
): boolean {
  return userTrustTier >= requiredTrustTier;
}

/**
 * Check if user has valid insurance if required by task.
 * Pure function - no side effects.
 */
export function checkInsurance(
  userInsuranceValid: boolean,
  insuranceRequired: boolean
): boolean {
  // Insurance not required = always passes
  if (!insuranceRequired) return true;
  
  // Insurance required = user must have valid insurance
  return userInsuranceValid;
}

/**
 * Check if user has valid background check if required by task.
 * Pure function - no side effects.
 */
export function checkBackgroundCheck(
  userBackgroundCheckValid: boolean,
  backgroundCheckRequired: boolean
): boolean {
  // Background check not required = always passes
  if (!backgroundCheckRequired) return true;
  
  // Background check required = user must have valid check
  return userBackgroundCheckValid;
}

/**
 * Check if task is open for applications.
 * Pure function - no side effects.
 */
export function checkTaskOpen(status: string): boolean {
  return status === 'OPEN' || status === 'open';
}

// ============================================================================
// MAIN ELIGIBILITY FUNCTION
// ============================================================================

/**
 * Determine if a user is eligible for a task.
 * 
 * This is a PURE FUNCTION - no side effects, deterministic output for same inputs.
 * Used by:
 * - FeedQueryService (SQL WHERE clause equivalent)
 * - Apply endpoint (defense-in-depth recheck)
 * 
 * Returns detailed breakdown of eligibility factors.
 */
export function isEligible(
  profile: CapabilityProfile,
  verifiedTrades: VerifiedTrade[],
  task: TaskRequirements
): EligibilityCheck {
  const checks = {
    locationMatch: checkLocationMatch(profile.locationState, task.locationState),
    riskClearance: checkRiskClearance(profile.riskClearance, task.riskLevel),
    tradeVerified: checkTradeVerified(verifiedTrades, task.requiredTrade),
    trustTier: checkTrustTier(profile.trustTier, task.requiredTrustTier),
    insurance: checkInsurance(profile.insuranceValid, task.insuranceRequired),
    backgroundCheck: checkBackgroundCheck(profile.backgroundCheckValid, task.backgroundCheckRequired),
    taskOpen: checkTaskOpen(task.status),
  };

  // All checks must pass for eligibility
  const eligible = Object.values(checks).every(check => check);

  // Build reasons for ineligibility
  const reasons: string[] = [];
  if (!checks.locationMatch) {
    reasons.push(`Location mismatch: user in ${profile.locationState}, task requires ${task.locationState}`);
  }
  if (!checks.riskClearance) {
    reasons.push(`Insufficient risk clearance: user cleared for ${profile.riskClearance.join(', ')}, task is ${task.riskLevel}`);
  }
  if (!checks.tradeVerified) {
    reasons.push(`Trade not verified: task requires ${task.requiredTrade}`);
  }
  if (!checks.trustTier) {
    reasons.push(`Insufficient trust tier: user tier ${profile.trustTier}, task requires tier ${task.requiredTrustTier}`);
  }
  if (!checks.insurance) {
    reasons.push('Valid insurance required');
  }
  if (!checks.backgroundCheck) {
    reasons.push('Valid background check required');
  }
  if (!checks.taskOpen) {
    reasons.push(`Task not open: status is ${task.status}`);
  }

  return {
    eligible,
    reasons,
    checks,
  };
}

/**
 * Simplified eligibility check - returns boolean only.
 * Use when you just need a yes/no answer.
 */
export function isEligibleBoolean(
  profile: CapabilityProfile,
  verifiedTrades: VerifiedTrade[],
  task: TaskRequirements
): boolean {
  return isEligible(profile, verifiedTrades, task).eligible;
}

// ============================================================================
// BATCH ELIGIBILITY
// ============================================================================

/**
 * Check eligibility for multiple tasks at once.
 * Returns map of taskId -> eligibility result.
 */
export function checkBatchEligibility(
  profile: CapabilityProfile,
  verifiedTrades: VerifiedTrade[],
  tasks: TaskRequirements[]
): Map<string, EligibilityCheck> {
  const results = new Map<string, EligibilityCheck>();
  
  for (const task of tasks) {
    results.set(task.taskId, isEligible(profile, verifiedTrades, task));
  }
  
  return results;
}

// ============================================================================
// SQL-FRIENDLY ELIGIBILITY PREDICATE
// ============================================================================

/**
 * Generate SQL WHERE clause for eligibility filtering.
 * This is the canonical feed query pattern.
 * 
 * Parameters:
 * - userId: The user's ID for the JOIN
 * 
 * Returns SQL fragment that can be used in a WHERE clause.
 */
export function getEligibilityWhereClause(userId: string): string {
  return `
    -- Location state match
    t.location_state = cp.location_state
    
    -- Risk clearance (cp.risk_clearance must include t.risk_level)
    AND t.risk_level = ANY(cp.risk_clearance)
    
    -- Trade requirement (if any)
    AND (t.required_trade IS NULL OR EXISTS (
      SELECT 1 FROM verified_trades vt 
      WHERE vt.user_id = '${userId}' 
        AND vt.trade = t.required_trade
        AND (vt.expires_at IS NULL OR vt.expires_at > NOW())
    ))
    
    -- Trust tier requirement
    AND cp.trust_tier >= t.required_trust_tier
    
    -- Insurance requirement
    AND (t.insurance_required = FALSE OR cp.insurance_valid = TRUE)
    
    -- Background check requirement
    AND (t.background_check_required = FALSE OR cp.background_check_valid = TRUE)
    
    -- Task must be open
    AND t.state = 'OPEN'
  `;
}

// ============================================================================
// ELIGIBILITY EXPLANATION
// ============================================================================

/**
 * Generate human-readable explanation of why a user is/isn't eligible.
 * Useful for the Work Eligibility screen in the UI.
 */
export function explainEligibility(
  profile: CapabilityProfile,
  verifiedTrades: VerifiedTrade[],
  task: TaskRequirements
): {
  eligible: boolean;
  summary: string;
  requirements: Array<{
    name: string;
    met: boolean;
    required: string;
    actual: string;
  }>;
} {
  const check = isEligible(profile, verifiedTrades, task);
  
  const requirements = [
    {
      name: 'Location',
      met: check.checks.locationMatch,
      required: `Work in ${task.locationState}`,
      actual: `Registered in ${profile.locationState}`,
    },
    {
      name: 'Risk Level',
      met: check.checks.riskClearance,
      required: `Clearance for ${task.riskLevel}-risk tasks`,
      actual: `Cleared for ${profile.riskClearance.join(', ')}-risk tasks`,
    },
    {
      name: 'Trade Verification',
      met: check.checks.tradeVerified,
      required: task.requiredTrade || 'No specific trade required',
      actual: `Verified trades: ${verifiedTrades.map(vt => vt.trade).join(', ') || 'None'}`,
    },
    {
      name: 'Trust Tier',
      met: check.checks.trustTier,
      required: `Tier ${task.requiredTrustTier}+`,
      actual: `Tier ${profile.trustTier}`,
    },
    {
      name: 'Insurance',
      met: check.checks.insurance,
      required: task.insuranceRequired ? 'Valid insurance required' : 'Not required',
      actual: profile.insuranceValid ? 'Valid insurance on file' : 'No valid insurance',
    },
    {
      name: 'Background Check',
      met: check.checks.backgroundCheck,
      required: task.backgroundCheckRequired ? 'Background check required' : 'Not required',
      actual: profile.backgroundCheckValid ? 'Valid background check' : 'No valid background check',
    },
  ];

  const summary = check.eligible
    ? 'You are eligible for this task!'
    : `You're not eligible: ${check.reasons[0]}`;

  return {
    eligible: check.eligible,
    summary,
    requirements,
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const EligibilityResolverService = {
  isEligible,
  isEligibleBoolean,
  checkBatchEligibility,
  getEligibilityWhereClause,
  explainEligibility,
  // Individual check functions for advanced use
  checkLocationMatch,
  checkRiskClearance,
  checkTradeVerified,
  checkTrustTier,
  checkInsurance,
  checkBackgroundCheck,
  checkTaskOpen,
};

export default EligibilityResolverService;
