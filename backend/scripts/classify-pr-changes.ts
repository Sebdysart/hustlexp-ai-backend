/**
 * PR Tier Classifier v1.0.0
 *
 * Deterministic classifier that scores PRs across 5 dimensions to determine
 * appropriate pipeline tier (TRIVIAL/STANDARD/CRITICAL/ARCHITECTURAL).
 *
 * This reduces pipeline cost ~60-80% by skipping expensive gates on low-risk changes
 * while maintaining full verification on financial/architectural changes.
 *
 * @see .github/workflows/orchestrator.yml
 */

import { execSync } from 'child_process';

// Tier definitions
export enum PRTier {
  TRIVIAL = 0,       // Docs, comments, assets - lint + typecheck only
  STANDARD = 1,      // Services, routers (non-financial) - full pipeline
  CRITICAL = 2,      // Escrow, Ledger, Payment, Trust, XP - full + mandatory invariants
  ARCHITECTURAL = 3, // Migrations, server.ts, config.ts - full + all gates required
}

// Tier thresholds for merge readiness
export const TIER_THRESHOLDS = {
  [PRTier.TRIVIAL]: 40,
  [PRTier.STANDARD]: 80,
  [PRTier.CRITICAL]: 90,
  [PRTier.ARCHITECTURAL]: 95,
};

// Dimension weights (total = 100)
const WEIGHTS = {
  blastRadius: 30,      // How many services/files affected
  securitySurface: 25,  // Authentication, authorization, payment
  dataMutation: 20,     // Schema changes, migrations
  userImpact: 15,       // UX changes, API contracts
  reversibility: 10,    // Can this be rolled back easily?
};

interface ClassificationResult {
  tier: PRTier;
  tierName: string;
  score: number;
  threshold: number;
  dimensions: {
    blastRadius: number;
    securitySurface: number;
    dataMutation: number;
    userImpact: number;
    reversibility: number;
  };
  justification: string[];
  changedFiles: string[];
}

// Critical file patterns (tier 2+)
const CRITICAL_PATTERNS = [
  /backend\/src\/services\/Escrow.*\.ts$/,
  /backend\/src\/services\/Ledger.*\.ts$/,
  /backend\/src\/services\/Payment.*\.ts$/,
  /backend\/src\/services\/Trust.*\.ts$/,
  /backend\/src\/services\/XP.*\.ts$/,
  /backend\/src\/routers\/escrow\.ts$/,
  /backend\/src\/routers\/xpTax\.ts$/,
];

// Architectural file patterns (tier 3)
const ARCHITECTURAL_PATTERNS = [
  /migrations\/.*\.sql$/,
  /backend\/src\/server\.ts$/,
  /backend\/src\/config\.ts$/,
  /backend\/src\/trpc\.ts$/,
  /backend\/src\/db\.ts$/,
  /\.github\/workflows\/orchestrator\.yml$/,
  /\.github\/workflows\/holodeck\.yml$/,
];

// Trivial file patterns (tier 0)
const TRIVIAL_PATTERNS = [
  /\.md$/,
  /^docs\//,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\/tests\//,
  /\.(png|jpg|jpeg|svg|gif|ico|webp)$/,
  /LICENSE/,
  /\.gitignore$/,
];

/**
 * Get list of changed files in the PR
 */
function getChangedFiles(): string[] {
  try {
    // In CI: compare against base branch
    const baseBranch = process.env.GITHUB_BASE_REF || 'main';
    const headBranch = process.env.GITHUB_HEAD_REF || 'HEAD';

    const diffCommand = process.env.CI
      ? `git diff --name-only origin/${baseBranch}...${headBranch}`
      : `git diff --name-only main...HEAD`;

    const output = execSync(diffCommand, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    console.error('Failed to get changed files:', error);
    return [];
  }
}

/**
 * Calculate blast radius score (0-100)
 * Based on: number of files, number of services, number of routers
 */
function calculateBlastRadius(files: string[]): number {
  const serviceCount = files.filter(f => f.includes('/services/')).length;
  const routerCount = files.filter(f => f.includes('/routers/')).length;
  const migrationCount = files.filter(f => f.includes('database/migrations/') || f.includes('constitutional-schema')).length;

  // Migrations have highest blast radius
  if (migrationCount > 0) return 100;

  // Multiple services/routers = high radius
  if (serviceCount + routerCount > 5) return 90;
  if (serviceCount + routerCount > 3) return 70;
  if (serviceCount + routerCount > 1) return 50;

  // Single file changes
  if (files.length === 1) return 10;
  if (files.length <= 3) return 30;

  return 60;
}

/**
 * Calculate security surface score (0-100)
 * Based on: authentication, authorization, payments, escrow, sensitive data
 */
function calculateSecuritySurface(files: string[]): number {
  const hasAuth = files.some(f => f.includes('auth') || f.includes('Auth'));
  const hasPayment = files.some(f =>
    f.includes('Payment') ||
    f.includes('Escrow') ||
    f.includes('Stripe') ||
    f.includes('escrow') ||
    f.includes('payment')
  );
  const hasTrust = files.some(f => f.includes('Trust') || f.includes('trust'));
  const hasMiddleware = files.some(f => f.includes('/middleware/'));

  if (hasPayment && hasAuth) return 100;
  if (hasPayment || hasTrust) return 90;
  if (hasAuth) return 70;
  if (hasMiddleware) return 60;

  return 20;
}

/**
 * Calculate data mutation score (0-100)
 * Based on: migrations, schema changes, database queries
 */
function calculateDataMutation(files: string[]): number {
  const hasMigration = files.some(f => f.includes('database/migrations/') || f.includes('constitutional-schema'));
  const hasDbChanges = files.some(f => f.includes('db.ts'));
  const hasServiceChanges = files.some(f => f.includes('/services/'));

  if (hasMigration) return 100;
  if (hasDbChanges) return 90;
  if (hasServiceChanges) return 50;

  return 10;
}

/**
 * Calculate user impact score (0-100)
 * Based on: API contracts, tRPC routers, iOS screens
 */
function calculateUserImpact(files: string[]): number {
  const hasRouterChanges = files.some(f => f.includes('/routers/'));
  const hasScreenChanges = files.some(f => f.includes('Screens/'));
  const hasTRPCChanges = files.some(f => f.includes('trpc.ts'));

  if (hasTRPCChanges) return 100;
  if (hasRouterChanges && hasScreenChanges) return 90;
  if (hasRouterChanges) return 70;
  if (hasScreenChanges) return 50;

  return 20;
}

/**
 * Calculate reversibility score (0-100)
 * Lower = more reversible = safer
 */
function calculateReversibility(files: string[]): number {
  const hasMigration = files.some(f => f.includes('database/migrations/') || f.includes('constitutional-schema'));
  const hasConfigChanges = files.some(f =>
    f.includes('config.ts') ||
    f.includes('server.ts') ||
    f.includes('.github/workflows/')
  );

  // Migrations are hardest to reverse
  if (hasMigration) return 100;

  // Config/workflow changes require redeployment
  if (hasConfigChanges) return 80;

  // Service changes can be rolled back
  const hasServiceChanges = files.some(f => f.includes('/services/'));
  if (hasServiceChanges) return 50;

  // Docs/tests are trivially reversible
  const allTrivial = files.every(f =>
    TRIVIAL_PATTERNS.some(p => p.test(f))
  );
  if (allTrivial) return 10;

  return 40;
}

/**
 * Classify PR based on changed files
 */
export function classifyPR(changedFiles?: string[]): ClassificationResult {
  const files = changedFiles || getChangedFiles();

  if (files.length === 0) {
    throw new Error('No changed files detected. Are you running this from a git repository?');
  }

  // Calculate dimension scores
  const dimensions = {
    blastRadius: calculateBlastRadius(files),
    securitySurface: calculateSecuritySurface(files),
    dataMutation: calculateDataMutation(files),
    userImpact: calculateUserImpact(files),
    reversibility: calculateReversibility(files),
  };

  // Weighted score (normalized to 0-100)
  const score =
    ((dimensions.blastRadius * WEIGHTS.blastRadius) +
    (dimensions.securitySurface * WEIGHTS.securitySurface) +
    (dimensions.dataMutation * WEIGHTS.dataMutation) +
    (dimensions.userImpact * WEIGHTS.userImpact) +
    (dimensions.reversibility * WEIGHTS.reversibility)) / 100;

  // Pattern-based tier overrides
  let tier: PRTier;
  const justification: string[] = [];

  // Check architectural patterns first (highest tier)
  if (files.some(f => ARCHITECTURAL_PATTERNS.some(p => p.test(f)))) {
    tier = PRTier.ARCHITECTURAL;
    justification.push('ARCHITECTURAL: Contains migrations, server config, or core infrastructure');
  }
  // Check critical patterns (financial/trust services)
  else if (files.some(f => CRITICAL_PATTERNS.some(p => p.test(f)))) {
    tier = PRTier.CRITICAL;
    justification.push('CRITICAL: Contains escrow, payment, trust, or XP services');
  }
  // Check trivial patterns
  else if (files.every(f => TRIVIAL_PATTERNS.some(p => p.test(f)))) {
    tier = PRTier.TRIVIAL;
    justification.push('TRIVIAL: Only documentation, tests, or assets');
  }
  // Check for service/router changes (default to STANDARD tier)
  else if (files.some(f => f.includes('/services/') || f.includes('/routers/'))) {
    // Service/router changes are at least STANDARD, unless score indicates CRITICAL
    if (score >= 70) {
      tier = PRTier.CRITICAL;
      justification.push(`CRITICAL: High risk score (${score.toFixed(0)}/100)`);
    } else {
      tier = PRTier.STANDARD;
      justification.push(`STANDARD: Service or router changes`);
    }
  }
  // Score-based classification for everything else
  else if (score >= 70) {
    tier = PRTier.CRITICAL;
    justification.push(`CRITICAL: High risk score (${score.toFixed(0)}/100)`);
  } else if (score >= 40) {
    tier = PRTier.STANDARD;
    justification.push(`STANDARD: Moderate risk score (${score.toFixed(0)}/100)`);
  } else {
    tier = PRTier.TRIVIAL;
    justification.push(`TRIVIAL: Low risk score (${score.toFixed(0)}/100)`);
  }

  // Add dimension justifications
  if (dimensions.blastRadius >= 80) {
    justification.push(`High blast radius (${dimensions.blastRadius}): ${files.length} files changed`);
  }
  if (dimensions.securitySurface >= 70) {
    justification.push(`High security surface (${dimensions.securitySurface}): auth/payment changes`);
  }
  if (dimensions.dataMutation >= 80) {
    justification.push(`High data mutation (${dimensions.dataMutation}): schema/migration changes`);
  }

  return {
    tier,
    tierName: PRTier[tier],
    score: Math.round(score),
    threshold: TIER_THRESHOLDS[tier],
    dimensions,
    justification,
    changedFiles: files,
  };
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const result = classifyPR();

  console.log('===== PR TIER CLASSIFICATION =====\n');
  console.log(`Tier: ${result.tierName} (${result.tier})`);
  console.log(`Risk Score: ${result.score}/100`);
  console.log(`Merge Threshold: ${result.threshold}/100`);
  console.log();
  console.log('Dimension Breakdown:');
  console.log(`  Blast Radius:     ${result.dimensions.blastRadius}/100`);
  console.log(`  Security Surface: ${result.dimensions.securitySurface}/100`);
  console.log(`  Data Mutation:    ${result.dimensions.dataMutation}/100`);
  console.log(`  User Impact:      ${result.dimensions.userImpact}/100`);
  console.log(`  Reversibility:    ${result.dimensions.reversibility}/100`);
  console.log();
  console.log('Justification:');
  result.justification.forEach(j => console.log(`  • ${j}`));
  console.log();
  console.log(`Changed Files (${result.changedFiles.length}):`);
  result.changedFiles.slice(0, 20).forEach(f => console.log(`  - ${f}`));
  if (result.changedFiles.length > 20) {
    console.log(`  ... and ${result.changedFiles.length - 20} more`);
  }

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `pr_tier=${result.tier}\n` +
      `pr_tier_name=${result.tierName}\n` +
      `pr_risk_score=${result.score}\n` +
      `pr_threshold=${result.threshold}\n`
    );
  }
}
