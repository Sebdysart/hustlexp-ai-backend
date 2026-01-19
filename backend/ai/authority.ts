/**
 * AI Authority Configuration
 * 
 * CONSTITUTIONAL: This file enforces AI authority levels from HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md
 * 
 * Authority Levels:
 * - A0: Forbidden - AI may not participate. Any AI output is ignored.
 * - A1: Read-Only - AI can summarize, extract, classify for display only. No state mutations.
 * - A2: Proposal-Only - AI outputs proposals validated by deterministic rules. Cannot directly change state.
 * - A3: Restricted Execution - AI may trigger limited reversible actions with strict gating.
 * 
 * Reference: HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md §3.1-3.2
 * 
 * @see /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md
 */

export type AIAuthorityLevel = 'A0' | 'A1' | 'A2' | 'A3';

export interface AuthorityConfig {
  level: AIAuthorityLevel;
  description: string;
  canMutateState: boolean;
  requiresValidation: boolean;
  requiresUserConsent: boolean;
  invariantRefs?: string[];
}

/**
 * Authority level definitions from AI_INFRASTRUCTURE.md §3.1
 */
export const AUTHORITY_LEVELS: Record<AIAuthorityLevel, AuthorityConfig> = {
  A0: {
    level: 'A0',
    description: 'Forbidden - AI may not participate. Any AI output is ignored.',
    canMutateState: false,
    requiresValidation: false,
    requiresUserConsent: false,
  },
  A1: {
    level: 'A1',
    description: 'Read-Only - AI can summarize, extract, classify for display only. No state mutations.',
    canMutateState: false,
    requiresValidation: false,
    requiresUserConsent: false,
  },
  A2: {
    level: 'A2',
    description: 'Proposal-Only - AI outputs proposals validated by deterministic rules. Cannot directly change state.',
    canMutateState: false,
    requiresValidation: true,
    requiresUserConsent: false,
  },
  A3: {
    level: 'A3',
    description: 'Restricted Execution - AI may trigger limited reversible actions with strict gating, explicit user consent, rate limits, audit trails, kill switch.',
    canMutateState: true,
    requiresValidation: true,
    requiresUserConsent: true,
  },
};

/**
 * Authority allocation table from AI_INFRASTRUCTURE.md §3.2
 * 
 * Hard Rule: XP/trust/payment/dispute finalization are NEVER A3. They remain A0 (deterministic only).
 */
export const SUBSYSTEM_AUTHORITY: Record<string, AIAuthorityLevel> = {
  // Onboarding
  'onboarding.role_inference': 'A2',
  
  // Task operations
  'task.classification': 'A2',
  'task.pricing_suggestion': 'A2',
  'task.matching_ranking': 'A2',
  
  // Fraud & Safety
  'fraud.risk_scoring': 'A2',
  'content.moderation_triage': 'A2',
  'dispute.assistance': 'A2', // A1/A2 per spec
  
  // Proof system
  'proof.request': 'A3', // INV-3
  'proof.analysis': 'A2', // INV-3
  
  // Support
  'support.drafting': 'A1',
  
  // FORBIDDEN (A0) - Never allow AI to mutate these
  'xp.award': 'A0', // INV-1, INV-5
  'trust.tier_mutation': 'A0',
  'escrow.release': 'A0', // INV-2, INV-4
  'escrow.capture': 'A0', // INV-2, INV-4
  'user.ban': 'A0',
  'user.suspend': 'A0',
  'dispute.resolve': 'A0',
};

/**
 * Check if a subsystem allows AI participation
 */
export function isAIAllowed(subsystem: string): boolean {
  const authority = SUBSYSTEM_AUTHORITY[subsystem];
  return authority !== 'A0';
}

/**
 * Get authority level for a subsystem
 */
export function getAuthorityLevel(subsystem: string): AIAuthorityLevel {
  return SUBSYSTEM_AUTHORITY[subsystem] || 'A0';
}

/**
 * Check if a subsystem can mutate state
 */
export function canMutateState(subsystem: string): boolean {
  const level = getAuthorityLevel(subsystem);
  return AUTHORITY_LEVELS[level].canMutateState;
}

/**
 * Check if a subsystem requires validation
 */
export function requiresValidation(subsystem: string): boolean {
  const level = getAuthorityLevel(subsystem);
  return AUTHORITY_LEVELS[level].requiresValidation;
}

/**
 * Check if a subsystem requires user consent
 */
export function requiresUserConsent(subsystem: string): boolean {
  const level = getAuthorityLevel(subsystem);
  return AUTHORITY_LEVELS[level].requiresUserConsent;
}

/**
 * Validate that an action does not violate A0 restrictions
 * 
 * Hard Rule: XP/trust/payment/dispute finalization are NEVER A3. They remain A0.
 */
export function validateAuthority(action: string, subsystem: string): {
  allowed: boolean;
  reason?: string;
  requiredLevel?: AIAuthorityLevel;
} {
  const authority = getAuthorityLevel(subsystem);
  
  // A0 is always forbidden
  if (authority === 'A0') {
    return {
      allowed: false,
      reason: `Subsystem "${subsystem}" is A0 (Forbidden). AI may not participate.`,
      requiredLevel: 'A0',
    };
  }
  
  // Check for forbidden actions regardless of subsystem
  const forbiddenActions = [
    'awardXP',
    'mutateTrustTier',
    'releaseEscrow',
    'captureEscrow',
    'banUser',
    'suspendUser',
    'resolveDispute',
  ];
  
  if (forbiddenActions.some(forbidden => action.toLowerCase().includes(forbidden.toLowerCase()))) {
    return {
      allowed: false,
      reason: `Action "${action}" is A0 (Forbidden). AI may not mutate XP, trust, payments, or user status.`,
      requiredLevel: 'A0',
    };
  }
  
  return {
    allowed: true,
    requiredLevel: authority,
  };
}

/**
 * Get HUSTLEXP-DOCS path reference
 * This ensures the orchestrator knows where to find constitutional specifications
 */
export const HUSTLEXP_DOCS_PATH = '/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS';

export const CONSTITUTIONAL_REFERENCES = {
  AI_INFRASTRUCTURE: `${HUSTLEXP_DOCS_PATH}/AI_INFRASTRUCTURE.md`,
  ARCHITECTURE: `${HUSTLEXP_DOCS_PATH}/ARCHITECTURE.md`,
  PRODUCT_SPEC: `${HUSTLEXP_DOCS_PATH}/PRODUCT_SPEC.md`,
  SCHEMA: `${HUSTLEXP_DOCS_PATH}/schema.sql`,
  BUILD_GUIDE: `${HUSTLEXP_DOCS_PATH}/BUILD_GUIDE.md`,
} as const;
