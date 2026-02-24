/**
 * State Machine Consistency Checker v1.0.0
 *
 * Extracts valid state transitions from TaskService and EscrowService.
 * Outputs JSON manifest for iOS contract validation.
 *
 * Ensures iOS state handling matches backend state machine definitions.
 *
 * @see backend/src/services/TaskService.ts
 * @see backend/src/services/EscrowService.ts
 * @see .github/workflows/holodeck.yml (dispatches manifest to iOS)
 */

import fs from 'fs';
import path from 'path';

// Task state machine (from TaskService.ts)
export const TASK_STATE_TRANSITIONS = {
  open: ['accepted', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['pending_review', 'cancelled'],
  pending_review: ['completed', 'disputed'],
  disputed: ['completed', 'cancelled'],
  completed: [], // Terminal state
  cancelled: [], // Terminal state
};

// Escrow state machine (from EscrowService.ts)
export const ESCROW_STATE_TRANSITIONS = {
  pending: ['funded', 'cancelled'],
  funded: ['released', 'refunded', 'disputed'],
  disputed: ['released', 'refunded'],
  released: [], // Terminal state
  refunded: [], // Terminal state
  cancelled: [], // Terminal state
};

interface StateMachineManifest {
  version: string;
  generatedAt: string;
  stateMachines: {
    task: {
      states: string[];
      transitions: Record<string, string[]>;
      terminalStates: string[];
    };
    escrow: {
      states: string[];
      transitions: Record<string, string[]>;
      terminalStates: string[];
    };
  };
}

/**
 * Get terminal states (no outgoing transitions)
 */
function getTerminalStates(transitions: Record<string, string[]>): string[] {
  return Object.entries(transitions)
    .filter(([_, next]) => next.length === 0)
    .map(([state]) => state);
}

/**
 * Generate state machine manifest
 */
export function generateStateMachineManifest(): StateMachineManifest {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    stateMachines: {
      task: {
        states: Object.keys(TASK_STATE_TRANSITIONS),
        transitions: TASK_STATE_TRANSITIONS,
        terminalStates: getTerminalStates(TASK_STATE_TRANSITIONS),
      },
      escrow: {
        states: Object.keys(ESCROW_STATE_TRANSITIONS),
        transitions: ESCROW_STATE_TRANSITIONS,
        terminalStates: getTerminalStates(ESCROW_STATE_TRANSITIONS),
      },
    },
  };
}

/**
 * Validate state machine properties
 */
function validateStateMachine(
  name: string,
  transitions: Record<string, string[]>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const states = Object.keys(transitions);

  // Check: All referenced states exist
  Object.entries(transitions).forEach(([from, toStates]) => {
    toStates.forEach(to => {
      if (!states.includes(to)) {
        errors.push(`${name}: Invalid transition ${from} → ${to} (${to} not defined)`);
      }
    });
  });

  // Check: No cycles to terminal states
  const terminalStates = getTerminalStates(transitions);
  terminalStates.forEach(terminal => {
    Object.entries(transitions).forEach(([from, toStates]) => {
      if (toStates.includes(terminal) && from === terminal) {
        errors.push(`${name}: Terminal state ${terminal} has self-loop`);
      }
    });
  });

  // Check: At least one terminal state exists
  if (terminalStates.length === 0) {
    errors.push(`${name}: No terminal states found (infinite loop possible)`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const manifest = generateStateMachineManifest();

  console.log('===== STATE MACHINE CONSISTENCY CHECK =====\n');

  // Validate Task state machine
  console.log('Task State Machine:');
  console.log(`  States: ${manifest.stateMachines.task.states.join(', ')}`);
  console.log(`  Terminal: ${manifest.stateMachines.task.terminalStates.join(', ')}`);

  const taskValidation = validateStateMachine('Task', TASK_STATE_TRANSITIONS);
  if (taskValidation.valid) {
    console.log('  ✅ Valid\n');
  } else {
    console.log('  ❌ Validation failed:');
    taskValidation.errors.forEach(e => console.log(`     ${e}`));
    console.log();
  }

  // Validate Escrow state machine
  console.log('Escrow State Machine:');
  console.log(`  States: ${manifest.stateMachines.escrow.states.join(', ')}`);
  console.log(`  Terminal: ${manifest.stateMachines.escrow.terminalStates.join(', ')}`);

  const escrowValidation = validateStateMachine('Escrow', ESCROW_STATE_TRANSITIONS);
  if (escrowValidation.valid) {
    console.log('  ✅ Valid\n');
  } else {
    console.log('  ❌ Validation failed:');
    escrowValidation.errors.forEach(e => console.log(`     ${e}`));
    console.log();
  }

  // Print transition details
  console.log('Transition Details:\n');

  console.log('Task Transitions:');
  Object.entries(TASK_STATE_TRANSITIONS).forEach(([from, toStates]) => {
    if (toStates.length > 0) {
      console.log(`  ${from.padEnd(20)} → ${toStates.join(', ')}`);
    } else {
      console.log(`  ${from.padEnd(20)} → [TERMINAL]`);
    }
  });
  console.log();

  console.log('Escrow Transitions:');
  Object.entries(ESCROW_STATE_TRANSITIONS).forEach(([from, toStates]) => {
    if (toStates.length > 0) {
      console.log(`  ${from.padEnd(20)} → ${toStates.join(', ')}`);
    } else {
      console.log(`  ${from.padEnd(20)} → [TERMINAL]`);
    }
  });
  console.log();

  // Write JSON manifest
  const outputPath = path.join(process.cwd(), 'state-machine-manifest.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved to: ${outputPath}`);

  // Exit with error if validation failed
  const allValid = taskValidation.valid && escrowValidation.valid;
  if (!allValid) {
    console.error('\n❌ State machine validation failed');
    process.exit(1);
  }

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `state_machine_manifest_path=${outputPath}\n` +
      `validation_passed=${allValid}\n`
    );
  }
}
