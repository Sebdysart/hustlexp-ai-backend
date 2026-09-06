import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresFakeFinancialAdmittedRequestRepository } from '../../src/jobs/fake-financial-admitted-request.js';
import { encodeFakeFinancialDurableRequest } from '../../src/services/payment/FakeFinancialDurableRequest.js';

function fixture() {
  const commandId = randomUUID();
  const workerId = randomUUID();
  const durable = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', {
    operationId: randomUUID(),
    idempotencyKey: `admitted:${randomUUID()}`,
    expectedVersion: 0,
    customerId: randomUUID(),
  });
  const input = {
    workerInstanceId: workerId,
    payload: {
      version: 1 as const,
      kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
      commandId,
      outboxRequestId: randomUUID(),
      jobAuthoritySha256: 'a'.repeat(64),
    },
    jobId: `hx-fake-fin-${commandId.replaceAll('-', '')}-${'a'.repeat(64)}`,
    bullmqAttemptNumber: 0,
    leaseSeconds: 30,
    outcomeTimeoutSeconds: 10,
  };
  const admission = {
    job_validation_id: randomUUID(),
    command_id: commandId,
    recovery_lease_id: randomUUID(),
    dispatch_attempt_id: randomUUID(),
    provider_request_sha256: durable.providerRequestSha256,
    command_identity_sha256: 'b'.repeat(64),
    prepared_command_id: randomUUID(),
    prepared_authority_sha256: 'c'.repeat(64),
  };
  const row: Record<string, unknown> = {
    ...admission,
    worker_instance_id: workerId,
    dispatch_admission_id: randomUUID(),
    outbox_request_id: input.payload.outboxRequestId,
    validation_identity_sha256: 'd'.repeat(64),
    admission_identity_sha256: 'e'.repeat(64),
    job_authority_sha256: input.payload.jobAuthoritySha256,
    bullmq_job_id: input.jobId,
    payload_contract_version: 1,
    canonical_provider_request: durable.canonicalRequestJson,
    operation_kind: durable.operationKind,
    operation_id: durable.request.operationId,
    idempotency_key: durable.request.idempotencyKey,
    provider_expected_version: '0',
    lease_expires_at: new Date(Date.now() + 30_000),
    outcome_deadline_at: new Date(Date.now() + 10_000),
    target_authority_id: randomUUID(),
    target_authority_version: 1,
    target_database_name: 'hx_ci_system_test',
    release_environment: 'local',
    release_manifest_digest: `sha256:${'f'.repeat(64)}`,
    release_id: 'v13.synthetic.test',
    release_revision: '1'.repeat(40),
    provider_execution_capability: false,
    positive_money_capability: false,
    production_capability: false,
  };
  const order: string[] = [];
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const control = { failCommit: 0, failQuery: 0, rowCount: 1, rows: [row] };
  let transaction = 0;
  const repository = new PostgresFakeFinancialAdmittedRequestRepository({
    transaction: async (callback) => {
      const number = ++transaction;
      order.push(`begin:${number}`);
      const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (control.failQuery === number) throw Error('DATABASE_REJECTED');
        return number === 1
          ? { rows: [admission] as T[], rowCount: 1 }
          : { rows: control.rows as T[], rowCount: control.rowCount };
      };
      const result = await callback(query);
      if (control.failCommit === number) throw Error('COMMIT_UNCONFIRMED');
      order.push(`commit:${number}`);
      return result;
    },
  });
  return { repository, input, admission, row, control, order, queries, durable };
}

describe('committed fake-financial admitted request readback', () => {
  it('commits admission before exact readback and returns immutable evidence with no capability', async () => {
    const f = fixture();
    const admission = await f.repository.admit(f.input);
    expect(f.order).toEqual(['begin:1', 'commit:1']);
    f.input.payload.outboxRequestId = randomUUID();
    f.input.workerInstanceId = randomUUID();
    const result = await f.repository.read(admission);
    expect(f.order).toEqual(['begin:1', 'commit:1', 'begin:2', 'commit:2']);
    expect(f.queries[1]).toEqual({
      sql: 'SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)',
      params: [admission.job_validation_id, f.row.worker_instance_id],
    });
    expect(result.durableRequest).toEqual(f.durable);
    expect(result.evidence.provider_expected_version).toBe(0);
    expect(result.evidence.provider_execution_capability).toBe(false);
    for (const value of [
      admission,
      result,
      result.evidence,
      result.durableRequest,
      result.durableRequest.request,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it('rejects forged and cross-repository admission objects before querying', async () => {
    const f = fixture();
    const issued = await f.repository.admit(f.input);
    await expect(f.repository.read({ ...issued })).rejects.toThrow('ADMISSION_NOT_ISSUED');
    const other = fixture();
    await expect(other.repository.read(issued)).rejects.toThrow('ADMISSION_NOT_ISSUED');
    expect(f.queries).toHaveLength(1);
    expect(other.queries).toHaveLength(0);
  });

  it.each([1, 2])(
    'does not expose evidence after transaction %i loses commit acknowledgement',
    async (number) => {
      const f = fixture();
      f.control.failCommit = number;
      if (number === 1) {
        await expect(f.repository.admit(f.input)).rejects.toThrow('COMMIT_UNCONFIRMED');
        await expect(f.repository.read(f.admission)).rejects.toThrow('ADMISSION_NOT_ISSUED');
        expect(f.queries).toHaveLength(1);
      } else {
        const issued = await f.repository.admit(f.input);
        await expect(f.repository.read(issued)).rejects.toThrow('COMMIT_UNCONFIRMED');
        expect(f.queries).toHaveLength(2);
      }
    }
  );

  it.each<[string, () => unknown]>([
    ['worker_instance_id', () => randomUUID()],
    ['command_id', () => randomUUID()],
    ['outbox_request_id', () => randomUUID()],
    ['job_validation_id', () => randomUUID()],
    ['recovery_lease_id', () => randomUUID()],
    ['dispatch_attempt_id', () => randomUUID()],
    ['prepared_command_id', () => randomUUID()],
    ['prepared_authority_sha256', () => '9'.repeat(64)],
    ['command_identity_sha256', () => '9'.repeat(64)],
    ['job_authority_sha256', () => '9'.repeat(64)],
    ['provider_request_sha256', () => '9'.repeat(64)],
    ['bullmq_job_id', () => 'forged'],
    ['idempotency_key', () => `other:${randomUUID()}`],
    ['provider_expected_version', () => '1'],
    ['operation_id', () => randomUUID()],
    ['canonical_provider_request', () => '{}'],
    ['release_environment', () => 'production'],
    ['payload_contract_version', () => 2],
    ['provider_execution_capability', () => true],
    ['positive_money_capability', () => true],
    ['production_capability', () => true],
    ['unexpected', () => true],
  ])('rejects altered %s readback without another admission', async (field, value) => {
    const f = fixture();
    const issued = await f.repository.admit(f.input);
    f.row[field] = value();
    await expect(f.repository.read(issued)).rejects.toThrow();
    expect(f.queries).toHaveLength(2);
    expect(f.order).toEqual(['begin:1', 'commit:1', 'begin:2']);
  });

  it.each(['missing', 'duplicate', 'count mismatch'] as const)('rejects %s rows', async (mode) => {
    const f = fixture();
    const issued = await f.repository.admit(f.input);
    if (mode === 'missing') {
      f.control.rows = [];
      f.control.rowCount = 0;
    }
    if (mode === 'duplicate') {
      f.control.rows = [f.row, f.row];
      f.control.rowCount = 2;
    }
    if (mode === 'count mismatch') f.control.rowCount = 0;
    await expect(f.repository.read(issued)).rejects.toThrow('READ_CARDINALITY');
  });

  it('propagates a database hold without attempting a new dispatch', async () => {
    const f = fixture();
    const issued = await f.repository.admit(f.input);
    f.control.failQuery = 2;
    await expect(f.repository.read(issued)).rejects.toThrow('DATABASE_REJECTED');
    expect(
      f.queries.filter((q) => q.sql.includes('record_fake_financial_job_dispatch'))
    ).toHaveLength(1);
  });

  it('rejects a forged queue identity before opening a transaction', async () => {
    const f = fixture();
    f.input.jobId = 'forged';
    await expect(f.repository.admit(f.input)).rejects.toThrow('JOB_IDENTITY_MISMATCH');
    expect(f.queries).toHaveLength(0);
  });
});
