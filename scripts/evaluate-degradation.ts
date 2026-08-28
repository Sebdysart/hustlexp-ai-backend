/**
 * evaluate-degradation.ts
 *
 * Called by the readiness score computation. Reads gate results and degradation
 * contracts to produce adjusted scores that respect tier policies.
 *
 * For each gate:
 *   passed=true     -> full points
 *   passed=degraded -> check contract tier:
 *     critical:  override score to BLOCKED
 *     standard:  half points + warning banner
 *     advisory:  full points (degradation is acceptable)
 *   passed=false    -> check contract tier:
 *     critical:  override score to BLOCKED
 *     standard:  zero points + warning
 *     advisory:  zero points (no warning)
 *
 * Outputs JSON and writes to $GITHUB_OUTPUT if available.
 */

import * as fs from 'fs';
import {
  PIPELINE_CONTRACTS,
  type DegradationContract,
} from '../backend/src/lib/degradation-contracts';

// ============================================================================
// TYPES
// ============================================================================

export type GateState = 'true' | 'degraded' | 'false';

export interface GateInput {
  gate: string;
  state: GateState;
  maxPoints: number;
  contractKey: string; // key into PIPELINE_CONTRACTS
}

export interface AdjustedGate {
  gate: string;
  originalState: GateState;
  adjustedPoints: number;
  warning: string | null;
}

export interface DegradationResult {
  overrideBlocked: boolean;
  blockedReason: string | null;
  adjustedGates: AdjustedGate[];
  warnings: string[];
}

// ============================================================================
// GATE-TO-CONTRACT MAPPING
// ============================================================================

const GATE_DEFINITIONS: GateInput[] = [
  { gate: 'knowledge_graph', state: 'true', maxPoints: 10, contractKey: 'knowledge_graph' },
  { gate: 'tdad',            state: 'true', maxPoints: 25, contractKey: 'tdad' },
  { gate: 'typecheck',       state: 'true', maxPoints: 8,  contractKey: 'typecheck' },
  { gate: 'lint',            state: 'true', maxPoints: 7,  contractKey: 'lint' },
  { gate: 'unit_tests',      state: 'true', maxPoints: 20, contractKey: 'unit_tests' },
  { gate: 'invariant_tests', state: 'true', maxPoints: 20, contractKey: 'invariant_tests' },
  { gate: 'holodeck',        state: 'true', maxPoints: 10, contractKey: 'holodeck' },
];

// ============================================================================
// CORE EVALUATION
// ============================================================================

export function evaluateDegradation(
  gateInputs: GateInput[],
  contracts: Record<string, DegradationContract> = PIPELINE_CONTRACTS,
): DegradationResult {
  const adjustedGates: AdjustedGate[] = [];
  const warnings: string[] = [];
  let overrideBlocked = false;
  let blockedReason: string | null = null;

  for (const input of gateInputs) {
    const contract = contracts[input.contractKey];
    const tier = contract?.tier ?? 'standard';

    if (input.state === 'true') {
      // Full pass -- full points, no warning
      adjustedGates.push({
        gate: input.gate,
        originalState: input.state,
        adjustedPoints: input.maxPoints,
        warning: null,
      });
      continue;
    }

    if (input.state === 'degraded') {
      if (tier === 'critical') {
        overrideBlocked = true;
        blockedReason = `Critical service "${input.gate}" is degraded — cannot proceed`;
        adjustedGates.push({
          gate: input.gate,
          originalState: input.state,
          adjustedPoints: 0,
          warning: blockedReason,
        });
        warnings.push(blockedReason);
      } else if (tier === 'standard') {
        const halfPoints = Math.floor(input.maxPoints / 2);
        const warning = `${contract?.description ?? input.gate} degraded — partial credit`;
        adjustedGates.push({
          gate: input.gate,
          originalState: input.state,
          adjustedPoints: halfPoints,
          warning,
        });
        warnings.push(warning);
      } else {
        // advisory -- degradation is acceptable
        adjustedGates.push({
          gate: input.gate,
          originalState: input.state,
          adjustedPoints: input.maxPoints,
          warning: null,
        });
      }
      continue;
    }

    // state === 'false' -- gate failed
    if (tier === 'critical') {
      overrideBlocked = true;
      blockedReason = `Critical service "${input.gate}" failed — pipeline blocked`;
      adjustedGates.push({
        gate: input.gate,
        originalState: input.state,
        adjustedPoints: 0,
        warning: blockedReason,
      });
      warnings.push(blockedReason);
    } else if (tier === 'standard') {
      const warning = `${contract?.description ?? input.gate} unavailable — zero points`;
      adjustedGates.push({
        gate: input.gate,
        originalState: input.state,
        adjustedPoints: 0,
        warning,
      });
      warnings.push(warning);
    } else {
      // advisory -- no warning, just zero points
      adjustedGates.push({
        gate: input.gate,
        originalState: input.state,
        adjustedPoints: 0,
        warning: null,
      });
    }
  }

  return { overrideBlocked, blockedReason, adjustedGates, warnings };
}

// ============================================================================
// CLI ENTRYPOINT
// ============================================================================

function readGateState(envKey: string): GateState {
  const val = process.env[envKey] ?? 'false';
  if (val === 'true' || val === 'success') return 'true';
  if (val === 'degraded') return 'degraded';
  return 'false';
}

function main(): void {
  // Read gate states from environment variables
  const gateInputs: GateInput[] = GATE_DEFINITIONS.map((def) => {
    const envKey = `GATE_${def.gate.toUpperCase()}`;
    return { ...def, state: readGateState(envKey) };
  });

  const result = evaluateDegradation(gateInputs);
  const json = JSON.stringify(result, null, 2);

  // Write JSON output
  console.log(json);

  // Write to $GITHUB_OUTPUT if available
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const lines = [
      `override_blocked=${result.overrideBlocked}`,
      `blocked_reason=${result.blockedReason ?? ''}`,
      `warning_count=${result.warnings.length}`,
    ];
    fs.appendFileSync(githubOutput, lines.join('\n') + '\n');
  }

  // Exit with error if blocked
  if (result.overrideBlocked) {
    console.error(`BLOCKED: ${result.blockedReason}`);
    process.exit(1);
  }
}

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith('evaluate-degradation.ts');
if (isDirectRun) {
  main();
}
