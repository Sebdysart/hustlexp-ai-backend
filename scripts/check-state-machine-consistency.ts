/**
 * check-state-machine-consistency.ts
 *
 * Extracts task and escrow state machines from the backend source code
 * using regex, then outputs a JSON manifest for cross-surface validation.
 *
 * Usage: npx tsx scripts/check-state-machine-consistency.ts > state-machine-manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface StateMachine {
  states: string[];
  transitions: Record<string, string[]>;
  terminalStates: string[];
}

interface StateMachineManifest {
  generatedAt: string;
  stateMachines: Record<string, StateMachine>;
}

/**
 * Parse a VALID_TRANSITIONS block from TypeScript source.
 * Expects the pattern:
 *   const VALID_TRANSITIONS: Record<...> = {
 *     STATE: ['TARGET1', 'TARGET2'],
 *     ...
 *   };
 */
function extractTransitions(source: string): Record<string, string[]> | null {
  // Match the entire VALID_TRANSITIONS object literal
  const blockMatch = source.match(
    /const\s+VALID_TRANSITIONS[\s\S]*?=\s*\{([\s\S]*?)\};/
  );
  if (!blockMatch) return null;

  const body = blockMatch[1];
  const transitions: Record<string, string[]> = {};

  // Match each line: STATE_NAME: ['A', 'B', ...],  or  STATE_NAME: [],
  const lineRegex = /(\w+):\s*\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(body)) !== null) {
    const state = match[1];
    const targetsRaw = match[2].trim();
    if (targetsRaw === '') {
      transitions[state] = [];
    } else {
      const targets = targetsRaw
        .split(',')
        .map(t => t.trim().replace(/['"]/g, ''))
        .filter(t => t.length > 0);
      transitions[state] = targets;
    }
  }

  return Object.keys(transitions).length > 0 ? transitions : null;
}

function buildStateMachine(transitions: Record<string, string[]>): StateMachine {
  const states = Object.keys(transitions);
  const terminalStates = states.filter(s => transitions[s].length === 0);
  return { states, transitions, terminalStates };
}

function main(): void {
  const taskServicePath = path.resolve(
    __dirname,
    '../backend/src/services/TaskService.ts'
  );
  const escrowServicePath = path.resolve(
    __dirname,
    '../backend/src/services/EscrowService.ts'
  );

  const machines: Record<string, StateMachine> = {};

  // Extract task state machine
  if (fs.existsSync(taskServicePath)) {
    const taskSource = fs.readFileSync(taskServicePath, 'utf-8');
    const taskTransitions = extractTransitions(taskSource);
    if (taskTransitions) {
      machines['task'] = buildStateMachine(taskTransitions);
    } else {
      process.stderr.write('WARNING: Could not extract task state machine from TaskService.ts\n');
    }
  } else {
    process.stderr.write('WARNING: TaskService.ts not found\n');
  }

  // Extract escrow state machine
  if (fs.existsSync(escrowServicePath)) {
    const escrowSource = fs.readFileSync(escrowServicePath, 'utf-8');
    const escrowTransitions = extractTransitions(escrowSource);
    if (escrowTransitions) {
      machines['escrow'] = buildStateMachine(escrowTransitions);
    } else {
      process.stderr.write('WARNING: Could not extract escrow state machine from EscrowService.ts\n');
    }
  } else {
    process.stderr.write('WARNING: EscrowService.ts not found\n');
  }

  const manifest: StateMachineManifest = {
    generatedAt: new Date().toISOString(),
    stateMachines: machines,
  };

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

main();
