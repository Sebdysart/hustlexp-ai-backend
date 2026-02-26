export interface Violation {
  file: string;
  line: number;
  invariant: string;
  message: string;
}

/**
 * INV-4: Ledger entries are immutable — no UPDATE/DELETE on ledger_entries.
 * Scans source for raw SQL that touches ledger_entries with mutation verbs.
 */
export function checkLedgerImmutability(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (
      (lower.includes('update') || lower.includes('delete')) &&
      lower.includes('ledger_entr')
    ) {
      violations.push({
        file: filePath,
        line: i + 1,
        invariant: 'INV-4',
        message: `Ledger mutation detected: "${line.trim()}" — ledger_entries are append-only`,
      });
    }
  });

  // Also check full source for multi-line SQL patterns
  const normalized = source.replace(/\s+/g, ' ').toLowerCase();
  if (
    (normalized.includes('update') || normalized.includes('delete')) &&
    normalized.includes('ledger_entries')
  ) {
    // Only add if not already caught line-by-line
    const alreadyCaught = violations.some(v => v.invariant === 'INV-4');
    if (!alreadyCaught) {
      violations.push({
        file: filePath,
        line: 0, // full-source match, no single line
        invariant: 'INV-4',
        message: `Multi-line ledger mutation detected in ${filePath} — ledger_entries are append-only`,
      });
    }
  }

  return violations;
}

/**
 * INV-1/5: Balance and payment amounts must be positive integers.
 * Flags direct numeric literal assignments to amount/escrowAmount that are <= 0.
 * (e.g., `amount: 0` or `amount: -100` — clearly invalid values)
 * Variable assignments are NOT flagged here (the variable may be validated upstream).
 */
export function checkAmountPositivity(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    // Flag: amount: 0 or amount: -N (numeric literal <= 0)
    const match = line.match(/\b(amount|escrowAmount)\s*:\s*(-?\d+)/);
    if (match) {
      const value = parseInt(match[2], 10);
      if (value <= 0) {
        violations.push({
          file: filePath,
          line: i + 1,
          invariant: 'INV-1/5',
          message: `Zero or negative amount literal '${match[2]}' assigned to '${match[1]}' — amounts must be positive (INV-1/5)`,
        });
      }
    }
  });

  return violations;
}

/**
 * Architecture Rule: No direct DB calls in routers.
 * Flags `db.` or `sql\`` usage inside files matching routers/ pattern.
 */
export function checkNoDirectDbInRouters(source: string, filePath: string): Violation[] {
  if (!filePath.includes('/routers/')) return [];

  const violations: Violation[] = [];
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    if (/\bdb\.\w+\(/.test(line) || /sql`/.test(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        invariant: 'ARCH-1',
        message: `Direct DB call in router: "${line.trim()}" — use a Service instead`,
      });
    }
  });

  return violations;
}
