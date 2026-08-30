import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260913_universal_v1_completion_delivery_receipt.sql';
const sql = readFileSync(resolve(process.cwd(), 'backend/database/migrations', fileName), 'utf8');

describe('Universal V1 completion delivery receipt migration', () => {
  it('is an append-only engine migration after execution facts', () => {
    const executionFactsIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260912_universal_v1_work_order_execution_facts',
    );
    const completionDeliveryIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260913_universal_v1_completion_delivery_receipt',
    );

    expect(executionFactsIndex).toBeGreaterThanOrEqual(0);
    expect(completionDeliveryIndex).toBe(executionFactsIndex + 1);
    expect(REQUIRED_MIGRATION_FILES[completionDeliveryIndex]).toEqual({
      name: '20260913_universal_v1_completion_delivery_receipt',
      fileName,
    });
    expect(sql).toContain('ALTER TABLE public.task_completion_delivery_events');
    expect(sql).toContain('task_completion_delivery_idempotency_unique');
    expect(sql).toContain('task_completion_delivery_universal_v1_shape_check');
  });

  it('binds task, Work Order, submitted completion, execution, and service identity', () => {
    for (const fragment of [
      'work_order_id UUID',
      'expected_completion_fact_id UUID',
      'expected_completion_version INTEGER',
      'expected_execution_version INTEGER',
      'provider_service_identity TEXT',
      'request_sha256 CHAR(64)',
      "completion.fact_kind <> 'SUBMITTED'",
      "execution.state <> 'COMPLETION_SUBMITTED'",
      "task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'",
      'task_record.worker_id IS NOT NULL',
      'service_actor.id = NEW.recorded_by',
      "'hustlexp.synthetic-communications-sink.v1:' || NEW.recorded_by::TEXT",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('does not add an assignment or financial write path', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO/iu);
    expect(sql).not.toMatch(
      /UPDATE\s+(?:public\.)?(?:tasks|task_financial|escrows|quote_payments)/iu
    );
  });
});
