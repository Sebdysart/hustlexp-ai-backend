import { describe, it, expect } from 'vitest';
import { checkLedgerImmutability, checkNoDirectDbInRouters } from '../../../scripts/citadel-rules/financial.js';

describe('citadel constitution enforcer', () => {
  it('flags UPDATE on ledger_entries', () => {
    const source = `await db.execute(sql\`UPDATE ledger_entries SET amount = 0\`)`;
    const violations = checkLedgerImmutability(source, 'src/services/Test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('INV-4');
  });

  it('allows SELECT on ledger_entries', () => {
    const source = `await db.execute(sql\`SELECT * FROM ledger_entries\`)`;
    const violations = checkLedgerImmutability(source, 'src/services/Test.ts');
    expect(violations).toHaveLength(0);
  });

  it('flags direct db call in router', () => {
    const source = `const result = await db.query('SELECT 1')`;
    const violations = checkNoDirectDbInRouters(source, 'src/routers/payment.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('ARCH-1');
  });

  it('ignores db calls in services', () => {
    const source = `const result = await db.query('SELECT 1')`;
    const violations = checkNoDirectDbInRouters(source, 'src/services/PaymentService.ts');
    expect(violations).toHaveLength(0);
  });
});
