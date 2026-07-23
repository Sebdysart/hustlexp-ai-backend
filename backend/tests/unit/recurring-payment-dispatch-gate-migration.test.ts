import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260722_recurring_payment_dispatch_gate.sql'),
  'utf8',
);

describe('recurring payment-before-dispatch migration', () => {
  it('adds a truthful pre-dispatch state and repairs unfunded pending offers', () => {
    expect(sql).toContain("'AWAITING_PAYMENT'");
    expect(sql).toContain("reservation.status='PENDING'");
    expect(sql).toContain("escrow.state='FUNDED'");
    expect(sql).toContain("reservation_state=reservation.pool_type||'_AWAITING_PAYMENT'");
  });

  it('indexes the funded activation queue without weakening terminal statuses', () => {
    expect(sql).toContain('recurring_provider_awaiting_payment_idx');
    for (const status of ['ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED']) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});
