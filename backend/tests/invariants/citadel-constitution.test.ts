import { describe, it, expect } from 'vitest';
import { checkLedgerImmutability, checkNoDirectDbInRouters, checkAmountPositivity } from '../../../scripts/citadel-rules/financial.js';
import { checkStateMachineTransitions } from '../../../scripts/citadel-rules/state-machine.js';

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

  it('flags direct status assignment outside service layer', () => {
    const source = `task.status = 'completed'`;
    const violations = checkStateMachineTransitions(source, 'src/routers/task.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('SM-1');
  });

  it('ignores status assignments inside Service files', () => {
    const source = `task.status = 'completed'`;
    const violations = checkStateMachineTransitions(source, 'src/services/TaskService.ts');
    expect(violations).toHaveLength(0);
  });

  it('flags zero amount literal', () => {
    const source = `const payload = { amount: 0, description: 'test' }`;
    const violations = checkAmountPositivity(source, 'src/services/PaymentService.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('INV-1/5');
  });

  it('allows positive amount literal', () => {
    const source = `const payload = { amount: 100, description: 'test' }`;
    const violations = checkAmountPositivity(source, 'src/services/PaymentService.ts');
    expect(violations).toHaveLength(0);
  });
});
