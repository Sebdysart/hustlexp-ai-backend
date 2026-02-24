/**
 * Degradation Contracts v1.0.0
 *
 * Typed registry of degradation policies for every pipeline stage and runtime
 * service. These contracts are CONFIGURATION, not code -- they define policy
 * for how each component degrades and when alerts fire.
 *
 * Tiers:
 *   critical  -- cannot degrade silently; failure blocks the pipeline/operation
 *   standard  -- can degrade with partial credit and warnings
 *   advisory  -- degradation is acceptable and may be silent
 *
 * @see circuit-breaker.ts (runtime enforcement)
 * @see scripts/evaluate-degradation.ts (pipeline enforcement)
 */

// ============================================================================
// TYPES
// ============================================================================

export type DegradationTier = 'critical' | 'standard' | 'advisory';
export type DegradationState = 'healthy' | 'degraded' | 'offline';

export interface DegradationContract {
  service: string;
  tier: DegradationTier;
  description: string;
  healthyBehavior: string;
  degradedBehavior: string;
  offlineBehavior: string;
  alertThreshold: number;        // consecutive failures before alerting
  maxDegradedDurationMs: number; // ms before escalation (0 = immediate)
}

// ============================================================================
// PIPELINE STAGE CONTRACTS
// ============================================================================

export const PIPELINE_CONTRACTS: Record<string, DegradationContract> = {
  typecheck: {
    service: 'typecheck',
    tier: 'critical',
    description: 'TypeScript compilation',
    healthyBehavior: 'Full type checking with zero errors',
    degradedBehavior: 'N/A — cannot degrade',
    offlineBehavior: 'Block all PRs',
    alertThreshold: 1,
    maxDegradedDurationMs: 0,
  },
  lint: {
    service: 'lint',
    tier: 'standard',
    description: 'ESLint code quality',
    healthyBehavior: 'Full lint with zero warnings',
    degradedBehavior: 'Proceed with lint warnings — deduct points from readiness score',
    offlineBehavior: 'Skip with warning note',
    alertThreshold: 3,
    maxDegradedDurationMs: 300_000, // 5 min
  },
  unit_tests: {
    service: 'unit_tests',
    tier: 'critical',
    description: 'Unit test suite',
    healthyBehavior: 'All tests pass with coverage gate',
    degradedBehavior: 'N/A — cannot degrade',
    offlineBehavior: 'Block all PRs',
    alertThreshold: 1,
    maxDegradedDurationMs: 0,
  },
  invariant_tests: {
    service: 'invariant_tests',
    tier: 'critical',
    description: 'Constitutional invariant enforcement',
    healthyBehavior: 'All invariant kill tests pass',
    degradedBehavior: 'N/A — cannot degrade',
    offlineBehavior: 'Block all PRs',
    alertThreshold: 1,
    maxDegradedDurationMs: 0,
  },
  knowledge_graph: {
    service: 'knowledge_graph',
    tier: 'standard',
    description: 'Semantic doc search for PR context',
    healthyBehavior: 'Full semantic search with affected invariants',
    degradedBehavior: 'Partial credit — PR proceeds without context enrichment',
    offlineBehavior: 'Skip with advisory note',
    alertThreshold: 3,
    maxDegradedDurationMs: 300_000, // 5 min
  },
  holodeck: {
    service: 'holodeck',
    tier: 'standard',
    description: 'Ephemeral Railway deployment',
    healthyBehavior: 'Full deploy + health check + type manifest',
    degradedBehavior: 'Type manifest generation only (no deploy)',
    offlineBehavior: 'Skip with advisory note',
    alertThreshold: 2,
    maxDegradedDurationMs: 600_000, // 10 min
  },
  tdad: {
    service: 'tdad',
    tier: 'standard',
    description: 'Test-driven development enforcement',
    healthyBehavior: 'Test files verified for all changed code',
    degradedBehavior: 'N/A — cannot degrade (but can be skipped for tier 0)',
    offlineBehavior: 'Skip with warning note',
    alertThreshold: 3,
    maxDegradedDurationMs: 300_000,
  },
  cost_tracking: {
    service: 'cost_tracking',
    tier: 'advisory',
    description: 'Pipeline cost metrics',
    healthyBehavior: 'Full cost logging to artifact',
    degradedBehavior: 'Silently skip',
    offlineBehavior: 'Silently skip',
    alertThreshold: 10,
    maxDegradedDurationMs: 86_400_000, // 24h
  },
};

// ============================================================================
// RUNTIME SERVICE CONTRACTS
// ============================================================================

export const RUNTIME_CONTRACTS: Record<string, DegradationContract> = {
  openai: {
    service: 'openai',
    tier: 'standard',
    description: 'OpenAI GPT-4o primary AI route',
    healthyBehavior: 'Direct API call with full context',
    degradedBehavior: 'Fallback to Groq fast route',
    offlineBehavior: 'Fallback chain: Groq -> Anthropic -> Alibaba',
    alertThreshold: 5,
    maxDegradedDurationMs: 300_000,
  },
  stripe: {
    service: 'stripe',
    tier: 'critical',
    description: 'Stripe payment processing',
    healthyBehavior: 'Direct API call for payments',
    degradedBehavior: 'Queue for retry (no silent failure)',
    offlineBehavior: 'Block payment operations, alert immediately',
    alertThreshold: 1,
    maxDegradedDurationMs: 0,
  },
  database: {
    service: 'database',
    tier: 'critical',
    description: 'PostgreSQL primary database',
    healthyBehavior: 'Direct connection via pool',
    degradedBehavior: 'PgBouncer fallback connection',
    offlineBehavior: 'Block all operations, alert immediately',
    alertThreshold: 1,
    maxDegradedDurationMs: 0,
  },
  groq: {
    service: 'groq',
    tier: 'advisory',
    description: 'Groq fast AI route',
    healthyBehavior: 'Direct API call',
    degradedBehavior: 'Skip, use next in fallback chain',
    offlineBehavior: 'Skip silently',
    alertThreshold: 3,
    maxDegradedDurationMs: 600_000,
  },
  deepseek: {
    service: 'deepseek',
    tier: 'advisory',
    description: 'DeepSeek reasoning AI route',
    healthyBehavior: 'Direct API call for complex reasoning',
    degradedBehavior: 'Fallback to OpenAI primary',
    offlineBehavior: 'Use deterministic fallback',
    alertThreshold: 5,
    maxDegradedDurationMs: 600_000,
  },
};

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

export function getContract(service: string): DegradationContract | undefined {
  return PIPELINE_CONTRACTS[service] || RUNTIME_CONTRACTS[service];
}

export function isCritical(service: string): boolean {
  const contract = getContract(service);
  return contract?.tier === 'critical';
}

export function canDegrade(service: string): boolean {
  const contract = getContract(service);
  return contract?.tier !== 'critical';
}
