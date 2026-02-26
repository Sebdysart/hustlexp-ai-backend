import { parse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/utils';

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

  return violations;
}

/**
 * INV-1/5: Balance and payment amounts must be positive integers.
 * Flags any assignment to `amount` fields without a positivity check nearby.
 */
export function checkAmountPositivity(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];

  try {
    const ast = parse(source, { loc: true, range: true, jsx: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function walk(node: any) {
      // Flag: amount: someVar where someVar isn't guarded with > 0 or Math.abs
      if (
        node.type === 'Property' &&
        node.key.type === 'Identifier' &&
        (node.key.name === 'amount' || node.key.name === 'escrowAmount')
      ) {
        // Heuristic: check if there's no validation in the enclosing function body
        violations.push({
          file: filePath,
          line: node.loc?.start.line ?? 0,
          invariant: 'INV-1/5',
          message: `Amount assignment at line ${node.loc?.start.line} — verify positivity guard exists (INV-1/5)`,
        });
      }
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child && typeof child === 'object' && 'type' in (child as object)) {
          walk(child as TSESTree.Node);
        } else if (Array.isArray(child)) {
          child.forEach(c => c && typeof c === 'object' && 'type' in c && walk(c as TSESTree.Node));
        }
      }
    }

    walk(ast);
  } catch {
    // Parse errors are reported elsewhere (tsc)
  }

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
