/**
 * EligibilityResolverService v1.0.0
 * 
 * CONSTITUTIONAL: Pure function eligibility engine
 * 
 * Determines if a user is eligible to perform a task based on:
 * - Capability profile (trades, risk levels)
 * - Task requirements (trade type, location, risk level)
 * - Real-time constraints (availability, active disputes, etc.)
 * 
 * This service is PURE and DETERMINISTIC:
 * - Same inputs always produce same outputs
 * - No side effects
 * - No database writes
 * 
 * @see ARCHITECTURE.md §11.4
 */

import { logger } from '../logger.js';
import type { CapabilityProfile } from './CapabilityProfileService.js';

const log = logger.child({ service: 'EligibilityResolverService' });

// ============================================================================
// TYPES
// ============================================================================

export interface TaskRequirements {
  trade: string;
  state: string;
  city?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  insuranceRequired: boolean;
  backgroundCheckRequired: boolean;
  minTrustTier?: string;
}

export interface EligibilityContext {
  userId: string;
  capabilityProfile: CapabilityProfile;
  activeTaskCount: number;
  hasActiveDispute: boolean;
  accountAgeDays: number;
  trustScore: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];        // Human-readable reasons
  code: string;            // Machine-readable code (HX401-HX499)
  confidence: 'high' | 'medium' | 'low';
  metadata: {
    matchingTrades: string[];
    riskMatch: boolean;
    insuranceMatch: boolean;
    backgroundCheckMatch: boolean;
  };
}

// ============================================================================
// RISK LEVELS
// ============================================================================

const RISK_HIERARCHY = ['low', 'medium', 'high', 'critical'];

function hasSufficientRiskClearance(
  userClearance: string[],
  requiredLevel: string
): boolean {
  const userMaxIndex = Math.max(
    ...userClearance.map(c => RISK_HIERARCHY.indexOf(c)),
    -1
  );
  const requiredIndex = RISK_HIERARCHY.indexOf(requiredLevel);
  return userMaxIndex >= requiredIndex;
}

// ============================================================================
// PURE ELIGIBILITY FUNCTION
// ============================================================================

/**
 * Pure function to determine eligibility
 * 
 * @param task - Task requirements
 * @param context - User context (capabilities, status, etc.)
 * @returns Eligibility result with detailed reasons
 */
export function isEligible(
  task: TaskRequirements,
  context: EligibilityContext
): EligibilityResult {
  const reasons: string[] = [];
  const matchingTrades: string[] = [];
  
  // Default result structure
  const result: EligibilityResult = {
    eligible: false,
    reasons: [],
    code: 'HX400',
    confidence: 'high',
    metadata: {
      matchingTrades: [],
      riskMatch: false,
      insuranceMatch: false,
      backgroundCheckMatch: false,
    },
  };

  // 1. Check for active disputes (hard block)
  if (context.hasActiveDispute) {
    reasons.push('Active dispute resolution in progress');
    result.code = 'HX401';
    result.reasons = reasons;
    return result;
  }

  // 2. Check task capacity (soft limit - configurable)
  if (context.activeTaskCount >= 5) {
    reasons.push(`Maximum active tasks reached (${context.activeTaskCount}/5)`);
    result.code = 'HX402';
    result.reasons = reasons;
    return result;
  }

  // 3. Check for matching trade in correct state
  const profile = context.capabilityProfile;
  const now = new Date();
  
  const validTrade = profile.verifiedTrades.find(t => 
    t.trade === task.trade &&
    t.state === task.state &&
    (!t.expiresAt || new Date(t.expiresAt) > now)
  );

  if (!validTrade) {
    // Check if they have the trade in a different state
    const hasTradeElsewhere = profile.verifiedTrades.find(t => 
      t.trade === task.trade &&
      (!t.expiresAt || new Date(t.expiresAt) > now)
    );

    if (hasTradeElsewhere) {
      reasons.push(`Licensed for ${task.trade} but not in ${task.state}`);
      result.code = 'HX403';
    } else {
      reasons.push(`Not licensed for ${task.trade}`);
      result.code = 'HX404';
    }
    result.reasons = reasons;
    return result;
  }

  matchingTrades.push(validTrade.trade);
  result.metadata.matchingTrades = matchingTrades;

  // 4. Check risk level clearance
  const riskMatch = hasSufficientRiskClearance(profile.riskClearance, task.riskLevel);
  result.metadata.riskMatch = riskMatch;
  
  if (!riskMatch) {
    reasons.push(`Task requires ${task.riskLevel} risk clearance, user has: ${profile.riskClearance.join(', ')}`);
    result.code = 'HX405';
    result.reasons = reasons;
    return result;
  }

  // 5. Check insurance requirement
  const insuranceMatch = !task.insuranceRequired || profile.insuranceValid;
  result.metadata.insuranceMatch = insuranceMatch;
  
  if (!insuranceMatch) {
    reasons.push('Task requires insurance coverage');
    result.code = 'HX406';
    result.reasons = reasons;
    return result;
  }

  // 6. Check background check requirement
  const bgMatch = !task.backgroundCheckRequired || profile.backgroundCheckValid;
  result.metadata.backgroundCheckMatch = bgMatch;
  
  if (!bgMatch) {
    reasons.push('Task requires background check');
    result.code = 'HX407';
    result.reasons = reasons;
    return result;
  }

  // 7. Check minimum trust tier (if specified)
  if (task.minTrustTier) {
    const tierOrder = ['D', 'C', 'B', 'A'];
    const userTierIndex = tierOrder.indexOf(profile.trustTier);
    const minTierIndex = tierOrder.indexOf(task.minTrustTier);
    
    if (userTierIndex < minTierIndex) {
      reasons.push(`Task requires trust tier ${task.minTrustTier} or higher`);
      result.code = 'HX408';
      result.reasons = reasons;
      return result;
    }
  }

  // All checks passed - user is eligible
  result.eligible = true;
  result.reasons = ['All eligibility requirements met'];
  result.code = 'HX200';
  
  log.debug({ 
    userId: context.userId, 
    task: task.trade, 
    state: task.state,
    code: result.code 
  }, 'Eligibility check passed');

  return result;
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Check eligibility for multiple tasks
 */
export function isEligibleForTasks(
  tasks: TaskRequirements[],
  context: EligibilityContext
): Map<string, EligibilityResult> {
  const results = new Map<string, EligibilityResult>();
  
  for (const task of tasks) {
    const result = isEligible(task, context);
    results.set(`${task.trade}:${task.state}`, result);
  }

  return results;
}

/**
 * Get all eligible tasks from a list
 */
export function filterEligibleTasks(
  tasks: TaskRequirements[],
  context: EligibilityContext
): TaskRequirements[] {
  return tasks.filter(task => isEligible(task, context).eligible);
}

// ============================================================================
// EXPLANATION HELPERS
// ============================================================================

/**
 * Get human-readable explanation for eligibility code
 */
export function getEligibilityExplanation(code: string): string {
  const explanations: Record<string, string> = {
    'HX200': 'Eligible - all requirements met',
    'HX400': 'Unknown eligibility error',
    'HX401': 'Blocked - active dispute in progress',
    'HX402': 'Blocked - maximum active tasks reached',
    'HX403': 'Blocked - trade license not valid in this state',
    'HX404': 'Blocked - not licensed for this trade',
    'HX405': 'Blocked - insufficient risk clearance',
    'HX406': 'Blocked - insurance required but not verified',
    'HX407': 'Blocked - background check required but not verified',
    'HX408': 'Blocked - trust tier below minimum requirement',
  };

  return explanations[code] || 'Unknown eligibility status';
}

/**
 * Get remediation steps for ineligibility
 */
export function getRemediationSteps(result: EligibilityResult): string[] {
  const steps: string[] = [];

  switch (result.code) {
    case 'HX401':
      steps.push('Wait for active dispute to be resolved');
      steps.push('Contact support if dispute is in error');
      break;
    case 'HX402':
      steps.push('Complete or cancel existing tasks to free up capacity');
      break;
    case 'HX403':
      steps.push('Apply for trade license in the required state');
      steps.push('Transfer existing license if reciprocity exists');
      break;
    case 'HX404':
      steps.push('Complete trade verification for this category');
      steps.push('Upload license or certification documents');
      break;
    case 'HX405':
      steps.push('Complete additional training for higher risk levels');
      steps.push('Request trust tier upgrade after completing more tasks');
      break;
    case 'HX406':
      steps.push('Upload proof of insurance');
      steps.push('Purchase insurance through platform partner');
      break;
    case 'HX407':
      steps.push('Complete background check verification');
      steps.push('Allow 3-5 business days for processing');
      break;
    case 'HX408':
      steps.push('Complete more tasks to increase trust tier');
      steps.push('Maintain high ratings and on-time completion');
      break;
  }

  return steps;
}

export default {
  isEligible,
  isEligibleForTasks,
  filterEligibleTasks,
  getEligibilityExplanation,
  getRemediationSteps,
  RISK_HIERARCHY,
};
