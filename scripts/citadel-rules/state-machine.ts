/**
 * Citadel State Machine Rules
 *
 * Static analysis rules for enforcing state machine invariants at code-review time.
 * These are used by citadel-constitution.test.ts to verify that prohibited patterns
 * are detected in source files.
 *
 * SM-1: State transitions must go through the service layer — no direct status assignment
 *        outside of *Service.ts files.
 */

export interface Violation {
  invariant: string;
  message: string;
  file: string;
  line?: number;
}

/**
 * Check for direct state/status assignment outside of service files.
 * SM-1: State transitions must go through TaskService, EscrowService, etc.
 *       Direct assignment like `task.status = 'completed'` bypasses guards.
 */
export function checkStateMachineTransitions(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];

  // Only flag non-service files (service files ARE allowed to do state transitions)
  if (/Service\.ts$/.test(filePath)) {
    return violations;
  }

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect direct status/state assignment patterns
    // Matches: task.status = '...', escrow.state = '...', etc.
    if (/\b\w+\.(status|state)\s*=\s*['"`]/.test(line)) {
      violations.push({
        invariant: 'SM-1',
        message:
          'Direct state/status assignment outside service layer — use TaskService or EscrowService',
        file: filePath,
        line: i + 1,
      });
    }
  }

  return violations;
}
