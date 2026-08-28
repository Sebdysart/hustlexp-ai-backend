import { describe, expect, it, vi } from 'vitest';
import { assertTaskMutationEligibility } from '../../src/services/TaskEligibilityPolicy.js';
import type { QueryFn } from '../../src/db.js';

const TASK_ID = '85000000-0000-4000-8000-000000000001';
const WORKER_ID = '84000000-0000-4000-8000-000000000002';

describe('task mutation eligibility environments', () => {
  it('remains production-only unless controlled TEST evidence is explicitly allowed', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 }) as unknown as QueryFn;

    await expect(assertTaskMutationEligibility(query, TASK_ID, WORKER_ID, {
      requireCurrentOffer: true,
      allowControlledTest: true,
    })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);
    const controlledSql = String(vi.mocked(query).mock.calls[1]?.[0]);
    expect(controlledSql).toContain("t.automation_classification='CONTROLLED_TEST'");
    expect(controlledSql).toContain('hxos_local_test_liquidity_witness_current_v2');
    expect(controlledSql).toContain("mutation_escrow.state='FUNDED'");
    expect(controlledSql).toContain("screening.provider_environment='CONTROLLED_TEST'");
    expect(controlledSql).toContain('offer.decision_ready=TRUE');
    expect(controlledSql).toContain('offer.customer_total_cents=t.price');
    expect(controlledSql).toContain('offer.scope_hash IS NOT DISTINCT FROM t.scope_hash');
  });

  it('does not attempt controlled TEST eligibility by default', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) as unknown as QueryFn;

    await expect(assertTaskMutationEligibility(query, TASK_ID, WORKER_ID, {
      requireCurrentOffer: true,
    })).rejects.toThrow('not currently eligible');

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain("automation_classification = 'PRODUCTION'");
  });

  it('rejects when the explicit controlled TEST evidence chain is incomplete', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) as unknown as QueryFn;

    await expect(assertTaskMutationEligibility(query, TASK_ID, WORKER_ID, {
      allowControlledTest: true,
    })).rejects.toThrow('not currently eligible');

    expect(query).toHaveBeenCalledTimes(2);
  });
});
