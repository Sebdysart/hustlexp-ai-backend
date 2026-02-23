/**
 * State Machine Consistency Unit Tests
 *
 * Validates that task and escrow state machines are structurally
 * sound: no dangling references, terminal states are truly terminal,
 * and expected states are present.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helper: extract VALID_TRANSITIONS from source (same logic as the script)
// ---------------------------------------------------------------------------

function extractTransitions(source: string): Record<string, string[]> | null {
  const blockMatch = source.match(
    /const\s+VALID_TRANSITIONS[\s\S]*?=\s*\{([\s\S]*?)\};/
  );
  if (!blockMatch) return null;

  const body = blockMatch[1];
  const transitions: Record<string, string[]> = {};

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

// ---------------------------------------------------------------------------
// Load state machines from source
// ---------------------------------------------------------------------------

const servicesDir = path.resolve(__dirname, '../../src/services');

const taskSource = fs.readFileSync(
  path.join(servicesDir, 'TaskService.ts'),
  'utf-8'
);
const escrowSource = fs.readFileSync(
  path.join(servicesDir, 'EscrowService.ts'),
  'utf-8'
);

const taskTransitions = extractTransitions(taskSource)!;
const escrowTransitions = extractTransitions(escrowSource)!;

// ---------------------------------------------------------------------------
// Task state machine tests
// ---------------------------------------------------------------------------

describe('Task State Machine', () => {
  const expectedStates = [
    'OPEN', 'MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED',
    'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED',
  ];

  const expectedTerminal = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

  it('should parse successfully', () => {
    expect(taskTransitions).not.toBeNull();
  });

  for (const state of expectedStates) {
    it(`has state: ${state}`, () => {
      expect(taskTransitions).toHaveProperty(state);
    });
  }

  for (const state of expectedTerminal) {
    it(`terminal state ${state} has empty transition array`, () => {
      expect(taskTransitions[state]).toEqual([]);
    });
  }

  it('all transition targets are valid states', () => {
    const allStates = new Set(Object.keys(taskTransitions));
    for (const [from, targets] of Object.entries(taskTransitions)) {
      for (const target of targets) {
        expect(
          allStates.has(target),
          `Task: ${from} -> ${target} references unknown state`
        ).toBe(true);
      }
    }
  });

  it('non-terminal states have at least one transition', () => {
    for (const [state, targets] of Object.entries(taskTransitions)) {
      if (!expectedTerminal.includes(state)) {
        expect(
          targets.length,
          `Non-terminal state ${state} has no transitions`
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Escrow state machine tests
// ---------------------------------------------------------------------------

describe('Escrow State Machine', () => {
  const expectedStates = [
    'PENDING', 'FUNDED', 'LOCKED_DISPUTE',
    'RELEASED', 'REFUNDED', 'REFUND_PARTIAL',
  ];

  const expectedTerminal = ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'];

  it('should parse successfully', () => {
    expect(escrowTransitions).not.toBeNull();
  });

  for (const state of expectedStates) {
    it(`has state: ${state}`, () => {
      expect(escrowTransitions).toHaveProperty(state);
    });
  }

  for (const state of expectedTerminal) {
    it(`terminal state ${state} has empty transition array`, () => {
      expect(escrowTransitions[state]).toEqual([]);
    });
  }

  it('all transition targets are valid states', () => {
    const allStates = new Set(Object.keys(escrowTransitions));
    for (const [from, targets] of Object.entries(escrowTransitions)) {
      for (const target of targets) {
        expect(
          allStates.has(target),
          `Escrow: ${from} -> ${target} references unknown state`
        ).toBe(true);
      }
    }
  });

  it('non-terminal states have at least one transition', () => {
    for (const [state, targets] of Object.entries(escrowTransitions)) {
      if (!expectedTerminal.includes(state)) {
        expect(
          targets.length,
          `Non-terminal state ${state} has no transitions`
        ).toBeGreaterThan(0);
      }
    }
  });
});
