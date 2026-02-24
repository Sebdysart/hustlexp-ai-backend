/**
 * Readiness Score Computer v3.0.0
 *
 * Computes PR merge readiness score (0-110+) based on pipeline gate results.
 * Supports:
 * - Tier-aware thresholds (TRIVIAL: 40, STANDARD: 80, CRITICAL: 90, ARCHITECTURAL: 95)
 * - Graceful degradation (partial credit for degraded gates)
 * - Bonus points for advanced features (Greptile AI review, migration safety)
 *
 * @see .github/workflows/orchestrator.yml (readiness-score job)
 */

import fs from 'fs';
import { TIER_THRESHOLDS, PRTier } from './classify-pr-changes';
import { DEGRADATION_CONTRACTS, evaluateDegradation } from './evaluate-degradation';

interface GateScore {
  gate: string;
  weight: number;
  status: 'passed' | 'degraded' | 'failed' | 'skipped';
  points: number;
  maxPoints: number;
  message: string;
}

interface ReadinessScore {
  score: number;
  maxScore: number;
  threshold: number;
  tier: number;
  tierName: string;
  passed: boolean;
  blocked: boolean;
  gates: GateScore[];
  bonuses: GateScore[];
  summary: string;
}

/**
 * Evaluate a single gate and assign points
 */
function evaluateGate(
  name: string,
  weight: number,
  rawStatus: string | boolean | undefined,
  degradationAllowed: boolean = true
): GateScore {
  // Normalize status
  let status: 'passed' | 'degraded' | 'failed' | 'skipped';
  let points = 0;

  if (rawStatus === true || rawStatus === 'true' || rawStatus === 'success') {
    status = 'passed';
    points = weight;
  } else if (rawStatus === 'degraded' && degradationAllowed) {
    status = 'degraded';
    // Partial credit from degradation contract
    const contract = DEGRADATION_CONTRACTS[name];
    points = contract ? (weight * contract.partialCredit) / 100 : weight * 0.5;
  } else if (rawStatus === 'skipped' || rawStatus === undefined || rawStatus === '') {
    status = 'skipped';
    points = weight; // Skipped gates don't penalize (treated as N/A)
  } else if (rawStatus === false || rawStatus === 'false' || rawStatus === 'failure') {
    status = 'failed';
    points = 0;
  } else {
    // Unknown status: treat as degraded if allowed, failed otherwise
    status = degradationAllowed ? 'degraded' : 'failed';
    points = degradationAllowed ? weight * 0.5 : 0;
  }

  const message =
    status === 'passed'
      ? 'Passed'
      : status === 'degraded'
      ? `Degraded (${Math.round((points / weight) * 100)}% credit)`
      : status === 'skipped'
      ? 'Skipped (N/A)'
      : 'Failed';

  return {
    gate: name,
    weight,
    status,
    points,
    maxPoints: weight,
    message,
  };
}

/**
 * Compute readiness score
 */
export function computeReadinessScore(): ReadinessScore {
  // Get PR tier
  const prTier = parseInt(process.env.GATE_PR_TIER || '1') as PRTier;
  const prTierName = PRTier[prTier] || 'STANDARD';
  const threshold = TIER_THRESHOLDS[prTier] || 80;

  // Check if degradation evaluation blocked the PR
  const degradationEval = evaluateDegradation();
  const blocked = degradationEval.overrideBlocked;

  // Core gates (100 points total)
  const gates: GateScore[] = [
    evaluateGate('Typecheck', 15, process.env.GATE_TYPECHECK, false), // Critical
    evaluateGate('Lint', 5, process.env.GATE_LINT, true), // Standard
    evaluateGate('Tests', 25, process.env.GATE_TESTS || process.env.GATE_UNIT_TESTS, false), // Critical
    evaluateGate('Invariants', 20, process.env.GATE_INVARIANTS || process.env.GATE_INVARIANT_TESTS, false), // Critical
    evaluateGate('TDAD', 10, process.env.GATE_TDAD, true), // Standard
    evaluateGate('Context', 15, process.env.GATE_CONTEXT || process.env.GATE_KNOWLEDGE_GRAPH, true), // Standard
    evaluateGate('Holodeck', 10, process.env.GATE_HOLODECK, true), // Standard
  ];

  // Bonus gates (up to +20 points)
  const bonuses: GateScore[] = [];

  // Migration Safety: +10 when passed, -30 when failed (critical)
  if (process.env.GATE_MIGRATION_SAFETY) {
    const migrationStatus = process.env.GATE_MIGRATION_SAFETY;
    if (migrationStatus === 'true' || migrationStatus === true) {
      bonuses.push({
        gate: 'Migration Safety',
        weight: 10,
        status: 'passed',
        points: 10,
        maxPoints: 10,
        message: 'Migration safety validated',
      });
    } else {
      bonuses.push({
        gate: 'Migration Safety',
        weight: -30,
        status: 'failed',
        points: -30,
        maxPoints: 10,
        message: 'Dangerous migration patterns detected (blocking)',
      });
    }
  }

  // Greptile AI Review: +10 bonus when passed
  if (process.env.GATE_GREPTILE) {
    const greptileStatus = process.env.GATE_GREPTILE;
    const greptileScore = parseInt(process.env.GATE_GREPTILE_SCORE || '0');
    const greptileCritical = parseInt(process.env.GATE_GREPTILE_CRITICAL || '0');

    if (greptileStatus === 'true' || greptileStatus === true) {
      if (greptileCritical === 0) {
        bonuses.push({
          gate: 'Greptile AI',
          weight: 10,
          status: 'passed',
          points: 10,
          maxPoints: 10,
          message: `Codebase-aware AI review passed (score: ${greptileScore})`,
        });
      } else {
        bonuses.push({
          gate: 'Greptile AI',
          weight: -5,
          status: 'degraded',
          points: -5,
          maxPoints: 10,
          message: `AI review found ${greptileCritical} critical issue(s)`,
        });
      }
    }
  }

  // Calculate total score
  const gatePoints = gates.reduce((sum, g) => sum + g.points, 0);
  const bonusPoints = bonuses.reduce((sum, b) => sum + b.points, 0);
  const score = Math.round(gatePoints + bonusPoints);
  const maxScore = gates.reduce((sum, g) => sum + g.maxPoints, 0);

  // Determine pass/fail
  const passed = !blocked && score >= threshold;

  // Generate summary
  let summary = `Score: ${score}/${maxScore} (threshold: ${threshold})`;
  if (blocked) {
    summary += ' — BLOCKED by critical failure';
  } else if (passed) {
    summary += ' — READY TO MERGE';
  } else {
    summary += ` — NEEDS ${threshold - score} more points`;
  }

  return {
    score,
    maxScore,
    threshold,
    tier: prTier,
    tierName: prTierName,
    passed,
    blocked,
    gates,
    bonuses,
    summary,
  };
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(result: ReadinessScore): string {
  const emoji = result.passed
    ? '✅'
    : result.blocked
    ? '🚨'
    : result.score >= result.threshold * 0.8
    ? '⚠️'
    : '❌';

  let md = `${emoji} **Readiness Score: ${result.score}/${result.maxScore}**\n\n`;

  md += `**PR Tier:** ${result.tierName} (merge threshold: ${result.threshold}/100)\n`;
  md += `**Status:** ${result.summary}\n\n`;

  if (result.blocked) {
    md += `> 🚨 **BLOCKED**: One or more critical gates failed. Fix blocking issues before merge.\n\n`;
  } else if (result.passed) {
    md += `> ✅ **READY TO MERGE**: All required checks passed.\n\n`;
  } else {
    md += `> ⚠️  **NOT READY**: Score below threshold. Review failing gates below.\n\n`;
  }

  md += `### Core Gates (100 points)\n\n`;
  md += `| Gate | Status | Points | Message |\n`;
  md += `|------|--------|--------|----------|\n`;

  result.gates.forEach(gate => {
    const statusIcon =
      gate.status === 'passed'
        ? '✅'
        : gate.status === 'degraded'
        ? '⚠️'
        : gate.status === 'skipped'
        ? '⏭️'
        : '❌';

    md += `| ${gate.gate} | ${statusIcon} ${gate.status} | ${gate.points}/${gate.maxPoints} | ${gate.message} |\n`;
  });

  if (result.bonuses.length > 0) {
    md += `\n### Bonus Gates\n\n`;
    md += `| Gate | Status | Points | Message |\n`;
    md += `|------|--------|--------|----------|\n`;

    result.bonuses.forEach(bonus => {
      const statusIcon = bonus.status === 'passed' ? '✨' : bonus.status === 'failed' ? '❌' : '⚠️';
      const pointsDisplay = bonus.points > 0 ? `+${bonus.points}` : `${bonus.points}`;

      md += `| ${bonus.gate} | ${statusIcon} ${bonus.status} | ${pointsDisplay} | ${bonus.message} |\n`;
    });
  }

  md += `\n---\n`;
  md += `\n<details>\n<summary>📊 Scoring Breakdown</summary>\n\n`;
  md += `**Tier Thresholds:**\n`;
  md += `- TRIVIAL (docs, tests): 40/100\n`;
  md += `- STANDARD (services, routers): 80/100\n`;
  md += `- CRITICAL (escrow, payments, XP): 90/100\n`;
  md += `- ARCHITECTURAL (migrations, config): 95/100\n\n`;

  md += `**Degradation Contracts:**\n`;
  md += `- Critical gates (typecheck, tests, invariants): 0% partial credit\n`;
  md += `- Standard gates (lint, context, holodeck): 30-70% partial credit\n`;
  md += `- Advisory gates (Greptile): 90% partial credit\n\n`;

  md += `</details>\n`;

  return md;
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const result = computeReadinessScore();

  console.log('===== READINESS SCORE =====\n');
  console.log(result.summary);
  console.log();

  console.log('Core Gates:');
  result.gates.forEach(gate => {
    console.log(`  ${gate.gate.padEnd(15)} ${gate.status.padEnd(10)} ${gate.points}/${gate.maxPoints}`);
  });

  if (result.bonuses.length > 0) {
    console.log('\nBonus Gates:');
    result.bonuses.forEach(bonus => {
      const pointsDisplay = bonus.points > 0 ? `+${bonus.points}` : `${bonus.points}`;
      console.log(`  ${bonus.gate.padEnd(15)} ${bonus.status.padEnd(10)} ${pointsDisplay}`);
    });
  }

  console.log();

  if (result.blocked) {
    console.log('🚨 PR BLOCKED\n');
  } else if (result.passed) {
    console.log('✅ READY TO MERGE\n');
  } else {
    console.log(`⚠️  NOT READY (needs ${result.threshold - result.score} more points)\n`);
  }

  // Generate markdown report
  const markdown = generateMarkdownReport(result);
  fs.writeFileSync('readiness-score.md', markdown);
  console.log('Markdown report saved to: readiness-score.md');

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `score=${result.score}\n` +
      `passed=${result.passed}\n` +
      `blocked=${result.blocked}\n`
    );
  }

  // Exit code: 0 = passed, 1 = not ready
  process.exit(result.passed ? 0 : 1);
}
