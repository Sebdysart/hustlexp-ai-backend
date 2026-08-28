import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260718_business_execution_contract.sql'),
  'utf8',
);

describe('business canonical execution database contract', () => {
  it('binds approved demand to canonical tasks with complete provenance', () => {
    expect(sql).toContain('bind_business_work_order');
    for (const field of [
      'business_organization_id', 'business_location_id', 'business_approval_request_id',
      'business_requester_id', 'business_approver_id', 'business_policy_snapshot',
      'canonical_task_id',
    ]) expect(sql).toContain(field);
    expect(sql).toContain('BIND_BUDGET_CAP_EXCEEDED');
    expect(sql).toContain('business_spend_ledger');
  });

  it('models preferred and backup supply without direct assignment authority', () => {
    expect(sql).toContain('business_provider_preferences');
    expect(sql).toContain('set_business_provider_preference');
    expect(sql).toContain("'PRIMARY','BACKUP'");
    expect(sql).not.toMatch(/UPDATE\s+tasks\s+SET\s+worker_id/i);
  });

  it('derives reporting and immutable settled invoice snapshots from canonical records', () => {
    expect(sql).toContain('business_work_order_reporting');
    expect(sql).toContain('business_provider_performance_reporting');
    expect(sql).toContain('business_invoice_snapshots');
    expect(sql).toContain('business_invoice_snapshot_lines');
    expect(sql).toContain('create_business_invoice_snapshot');
    expect(sql).toContain('prevent_business_execution_evidence_mutation');
    expect(sql).toContain('business_invoice_snapshot_immutable');
    expect(sql).toContain("escrow.state IN ('RELEASED','REFUNDED','REFUND_PARTIAL')");
  });

  it('revokes public execution of authority-changing functions', () => {
    for (const fn of [
      'bind_business_work_order', 'set_business_provider_preference',
      'create_business_invoice_snapshot',
    ]) expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`, 'i'));
  });
});
