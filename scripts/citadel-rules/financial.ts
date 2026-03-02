/**
 * Citadel Financial Rules
 *
 * Static analysis rules for enforcing financial invariants at code-review time.
 * These are used by citadel-constitution.test.ts to verify that prohibited patterns
 * are detected in source files.
 *
 * INV-4:    Ledger entries are immutable — no UPDATE/DELETE on ledger_entries
 * ARCH-1:   No direct db calls in router files — must go through service layer
 * INV-1/5:  Payment amounts must be positive — amount: 0 is flagged
 */

export interface Violation {
  invariant: string;
  message: string;
  file: string;
  line?: number;
}

/**
 * Check for UPDATE or DELETE operations on ledger_entries table.
 * INV-4: Ledger entries are immutable — no UPDATE/DELETE allowed.
 */
export function checkLedgerImmutability(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect UPDATE ledger_entries or DELETE FROM ledger_entries patterns
    if (/UPDATE\s+ledger_entries/i.test(line) || /DELETE\s+FROM\s+ledger_entries/i.test(line)) {
      violations.push({
        invariant: 'INV-4',
        message: 'Ledger entries are immutable — UPDATE/DELETE on ledger_entries is forbidden',
        file: filePath,
        line: i + 1,
      });
    }
  }

  return violations;
}

/**
 * Check for direct db calls in router files.
 * ARCH-1: Database access must go through the service layer, not directly in routers.
 */
export function checkNoDirectDbInRouters(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];

  // Only flag router files (path contains /routers/)
  if (!/\/routers\//.test(filePath)) {
    return violations;
  }

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect direct db.query / db.execute calls
    if (/\bdb\.(query|execute|transaction|serializableTransaction)\s*\(/.test(line)) {
      violations.push({
        invariant: 'ARCH-1',
        message: 'Direct database call in router file — use service layer instead',
        file: filePath,
        line: i + 1,
      });
    }
  }

  return violations;
}

/**
 * Check for zero amount literals in financial contexts.
 * INV-1/5: Payment amounts must be positive — amount: 0 is a potential bug.
 */
export function checkAmountPositivity(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect amount: 0 pattern (zero amount literal)
    if (/\bamount\s*:\s*0\b/.test(line)) {
      violations.push({
        invariant: 'INV-1/5',
        message: 'Zero amount detected — payment amounts must be positive integers in cents',
        file: filePath,
        line: i + 1,
      });
    }
  }

  return violations;
}
