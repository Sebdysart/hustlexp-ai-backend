/**
 * Degradation Evaluator v1.0.0
 *
 * Evaluates pipeline gate failures against degradation contracts.
 * Determines which failures are critical (blocking) vs standard (degraded) vs advisory (silent).
 *
 * Three-tier scoring:
 * - PASSED: Gate passed successfully
 * - DEGRADED: Gate failed but has standard/advisory contract (partial credit)
 * - FAILED: Gate failed and is critical (zero credit, may block PR)
 *
 * @see .github/workflows/orchestrator.yml (readiness-score job)
 * @see backend/src/lib/degradation-contracts.ts
 */

export type DegradationTier = 'critical' | 'standard' | 'advisory';

export interface DegradationContract {
  service: string;
  tier: DegradationTier;
  degradedBehavior: string;
  partialCredit: number; // 0-100, percentage of full points awarded when degraded
}

// Degradation policy registry
export const DEGRADATION_CONTRACTS: Record<string, DegradationContract> = {
  typecheck: {
    service: 'TypeScript Compiler',
    tier: 'critical',
    degradedBehavior: 'Block PR — type errors must be fixed',
    partialCredit: 0,
  },
  lint: {
    service: 'ESLint',
    tier: 'standard',
    degradedBehavior: 'Warn in PR comment — merge with caution',
    partialCredit: 50,
  },
  tests: {
    service: 'Unit/Integration Tests',
    tier: 'critical',
    degradedBehavior: 'Block PR — tests must pass',
    partialCredit: 0,
  },
  invariants: {
    service: 'Constitutional Invariant Tests',
    tier: 'standard',
    degradedBehavior: 'Invariants covered by unit tests — standalone job optional',
    partialCredit: 90,
  },
  tdad: {
    service: 'TDAD (Tests Accompany Code)',
    tier: 'standard',
    degradedBehavior: 'Reduce score — tests recommended but not required',
    partialCredit: 30,
  },
  knowledgeGraph: {
    service: 'Knowledge Graph Context',
    tier: 'standard',
    degradedBehavior: 'Proceed with warning — context unavailable',
    partialCredit: 70,
  },
  holodeck: {
    service: 'Holodeck Ephemeral Deploy',
    tier: 'standard',
    degradedBehavior: 'Skip iOS validation — backend tests still ran',
    partialCredit: 60,
  },
  migrationSafety: {
    service: 'Migration Safety Analysis',
    tier: 'critical',
    degradedBehavior: 'Block PR — dangerous migration patterns detected',
    partialCredit: 0,
  },
  greptile: {
    service: 'Greptile AI Review',
    tier: 'advisory',
    degradedBehavior: 'Log only — Greptile unavailable',
    partialCredit: 90,
  },
};

export interface GateEvaluationResult {
  gate: string;
  status: 'passed' | 'degraded' | 'failed';
  contract: DegradationContract;
  partialCredit: number;
}

export interface DegradationEvaluation {
  overrideBlocked: boolean; // true if any critical gate failed
  results: GateEvaluationResult[];
  summary: string;
}

/**
 * Evaluate gate status against degradation contract
 */
function evaluateGate(
  gate: string,
  rawStatus: string | boolean | undefined,
  contract: DegradationContract
): GateEvaluationResult {
  // Normalize status
  let status: 'passed' | 'degraded' | 'failed';

  if (rawStatus === true || rawStatus === 'true' || rawStatus === 'success') {
    status = 'passed';
  } else if (rawStatus === 'degraded') {
    status = 'degraded';
  } else if (rawStatus === false || rawStatus === 'false' || rawStatus === 'failure' || !rawStatus) {
    // Check if degradation is allowed
    if (contract.tier === 'critical') {
      status = 'failed';
    } else {
      status = 'degraded';
    }
  } else {
    // Default: treat unknown status as degraded
    status = 'degraded';
  }

  // Determine partial credit
  const partialCredit =
    status === 'passed' ? 100 : status === 'degraded' ? contract.partialCredit : 0;

  return {
    gate,
    status,
    contract,
    partialCredit,
  };
}

/**
 * Evaluate all gates and determine if PR should be blocked
 */
export function evaluateDegradation(): DegradationEvaluation {
  const gates = [
    { name: 'typecheck', rawStatus: process.env.GATE_TYPECHECK },
    { name: 'lint', rawStatus: process.env.GATE_LINT },
    { name: 'tests', rawStatus: process.env.GATE_TESTS || process.env.GATE_UNIT_TESTS },
    { name: 'invariants', rawStatus: process.env.GATE_INVARIANTS || process.env.GATE_INVARIANT_TESTS },
    { name: 'tdad', rawStatus: process.env.GATE_TDAD },
    { name: 'knowledgeGraph', rawStatus: process.env.GATE_KNOWLEDGE_GRAPH || process.env.GATE_CONTEXT },
    { name: 'holodeck', rawStatus: process.env.GATE_HOLODECK },
    { name: 'migrationSafety', rawStatus: process.env.GATE_MIGRATION_SAFETY },
    { name: 'greptile', rawStatus: process.env.GATE_GREPTILE },
  ];

  const results = gates.map(({ name, rawStatus }) => {
    const contract = DEGRADATION_CONTRACTS[name];
    if (!contract) {
      throw new Error(`No degradation contract found for gate: ${name}`);
    }
    return evaluateGate(name, rawStatus, contract);
  });

  // Check if any critical gate failed
  const criticalFailures = results.filter(
    r => r.contract.tier === 'critical' && r.status === 'failed'
  );

  const overrideBlocked = criticalFailures.length > 0;

  // Generate summary
  const passedCount = results.filter(r => r.status === 'passed').length;
  const degradedCount = results.filter(r => r.status === 'degraded').length;
  const failedCount = results.filter(r => r.status === 'failed').length;

  let summary = `${passedCount} passed, ${degradedCount} degraded, ${failedCount} failed`;

  if (overrideBlocked) {
    summary += ` — BLOCKED by critical failure(s): ${criticalFailures.map(f => f.gate).join(', ')}`;
  } else if (degradedCount > 0) {
    const degradedGates = results.filter(r => r.status === 'degraded').map(r => r.gate);
    summary += ` — degraded gates: ${degradedGates.join(', ')}`;
  }

  return {
    overrideBlocked,
    results,
    summary,
  };
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const evaluation = evaluateDegradation();

  console.log('===== DEGRADATION CONTRACT EVALUATION =====\n');

  console.log(evaluation.summary);
  console.log();

  evaluation.results.forEach(result => {
    const icon =
      result.status === 'passed' ? '✅' : result.status === 'degraded' ? '⚠️ ' : '❌';

    console.log(`${icon} ${result.gate.padEnd(20)} ${result.status.toUpperCase()}`);
    console.log(`   Contract: ${result.contract.tier} — ${result.contract.degradedBehavior}`);
    console.log(`   Credit: ${result.partialCredit}%`);
    console.log();
  });

  if (evaluation.overrideBlocked) {
    console.log('🚨 PR BLOCKED — Critical gate failure(s) detected\n');
  } else {
    console.log('✅ No critical failures — PR may proceed\n');
  }

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `overrideBlocked=${evaluation.overrideBlocked}\n` +
      `degradation_summary=${evaluation.summary}\n`
    );
  }

  // Exit code: 0 = not blocked, 1 = blocked
  process.exit(evaluation.overrideBlocked ? 1 : 0);
}
