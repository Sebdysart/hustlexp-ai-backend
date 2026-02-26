import type { Violation } from './financial.js';

// Valid transitions from CLAUDE.md
const TASK_TRANSITIONS: Record<string, string[]> = {
  open: ['assigned'],
  assigned: ['in_progress', 'open'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const ESCROW_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['FUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'DISPUTED'],
  RELEASED: [],
  REFUNDED: [],
  DISPUTED: ['RELEASED', 'REFUNDED'],
};

/**
 * Flags direct state string assignments that skip the service layer.
 * Pattern: status = 'completed' without going through TaskService.
 */
export function checkStateMachineTransitions(source: string, filePath: string): Violation[] {
  if (filePath.includes('Service.ts') || filePath.includes('.test.ts')) return [];

  const violations: Violation[] = [];
  const lines = source.split('\n');
  const stateValues = [
    ...Object.keys(TASK_TRANSITIONS),
    ...Object.keys(ESCROW_TRANSITIONS),
  ];

  lines.forEach((line, i) => {
    for (const state of stateValues) {
      if (
        new RegExp(`status\\s*=\\s*['"\`]${state}['"\`]`).test(line) ||
        new RegExp(`status:\\s*['"\`]${state}['"\`]`).test(line)
      ) {
        violations.push({
          file: filePath,
          line: i + 1,
          invariant: 'SM-1',
          message: `Direct state assignment '${state}' outside service layer: "${line.trim()}"`,
        });
      }
    }
  });

  return violations;
}
