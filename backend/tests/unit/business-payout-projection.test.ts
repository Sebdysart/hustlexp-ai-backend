import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
import { assignmentPayoutState } from '../../src/services/ServiceBusinessAssignmentReadService.js';
const completed = { escrow_state: 'RELEASED', task_state: 'COMPLETED', provider_transfer_id: null };
describe('business payout read projection', () => {
  it('identifies the completed merchant charge without claiming a bank/transfer settlement', () => {
    expect(assignmentPayoutState({ ...completed, provider_transfer_status: 'not_applicable' }))
      .toBe('MERCHANT_PAYMENT_CONFIRMED');
  });
  it('retains the confirmed transfer projection for local/historical transfer evidence', () => {
    expect(assignmentPayoutState({ ...completed, provider_transfer_id: 'transfer', provider_transfer_status: 'paid' }))
      .toBe('CONNECTED_BALANCE_CONFIRMED');
  });
  it('does not infer a payment confirmation from a status without a completed escrow record', () => {
    expect(assignmentPayoutState({ ...completed, escrow_state: 'FUNDED', provider_transfer_status: 'not_applicable' }))
      .toBe('PENDING_CLEARANCE');
  });
  it('keeps dispute/refund projections intact', () => {
    expect(assignmentPayoutState({ ...completed, escrow_state: 'LOCKED_DISPUTE', provider_transfer_status: null })).toBe('HELD');
    expect(assignmentPayoutState({ ...completed, escrow_state: 'REFUNDED', provider_transfer_status: null })).toBe('REFUNDED_OR_REVERSED');
  });
});
