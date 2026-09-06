import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Database, QueryFn } from '../../src/db.js';
import { PostgresUniversalV1WorkerChangeOrderAdjustments } from '../../src/services/payment/UniversalV1WorkerChangeOrderAdjustment.js';
import { encodeFakeFinancialDurableRequest } from '../../src/services/payment/FakeFinancialDurableRequest.js';
import { prepareFinancialProviderCommand } from '../../src/services/payment/FinancialProviderCommandJournal.js';

function fixture(scenario: 'SUCCESS' | 'RETRY' = 'SUCCESS') {
  const authority = {
    databaseName: 'hx_ci_adjustment',
    serviceLogin: 'hx_ci_worker',
    environment: 'local' as const,
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    targetDigest: 'sha256:' + 'b'.repeat(64),
    releaseId: 'synthetic.worker.adjustment',
    revision: 'e'.repeat(40),
    authenticationStatus: 'VERIFIED' as const,
  };
  const lease = {
    proposal_id: randomUUID(),
    recovery_lease_id: randomUUID(),
    lease_owner_id: randomUUID(),
    witness_request_sha256: 'c'.repeat(64),
    work_order_id: randomUUID(),
    acquired_at: '2026-09-05T00:00:00Z',
    expires_at: '2026-09-05T00:05:00Z',
    target_authority_id: randomUUID(),
    release_manifest_digest: authority.manifestDigest,
  };
  const request = {
    operationId: randomUUID(),
    idempotencyKey: 'worker:adjustment:fixture',
    expectedVersion: 0,
    changeOrderId: lease.proposal_id,
    scopeVersionId: randomUUID(),
    relatedOperationId: randomUUID(),
    amountCents: 8000,
    currency: 'usd',
    scenario,
  };
  const durable = encodeFakeFinancialDurableRequest('ADJUST', request);
  const prepared = {
    prepared_command_id: randomUUID(),
    command_state: 'PREPARED',
    operation_kind: 'ADJUST',
    event_kind: 'ADJUSTMENT_AUTHORIZED',
    operation_id: request.operationId,
    provider_kind: 'FAKE',
    idempotency_key: request.idempotencyKey,
    provider_expected_version: 0,
    lifecycle_expected_version: 3,
    provider_request_sha256: durable.providerRequestSha256,
    task_draft_id: randomUUID(),
    task_id: randomUUID(),
    eligibility_decision_id: randomUUID(),
    eligibility_decision_version: 1,
    eligibility_valid_until: '2026-09-05T00:01:00Z',
    scope_version_id: request.scopeVersionId,
    scope_version: 2,
    scope_hash: 'f'.repeat(64),
    work_order_id: lease.work_order_id,
    work_order_materialization_version: 1,
    work_order_execution_contract_version: 1,
    change_order_id: lease.proposal_id,
    change_order_version: 1,
    predecessor_event_id: randomUUID(),
    predecessor_operation_id: request.relatedOperationId,
    predecessor_event_kind: 'SECURED',
    predecessor_status: 'SUCCEEDED',
    predecessor_lifecycle_version: 2,
    completion_fact_id: null,
    completion_version: null,
    related_operation_id: request.relatedOperationId,
    amount_cents: 8000,
    currency: 'USD',
    recorded_by: randomUUID(),
    occurred_at: '2026-09-05T00:00:01.123456+00:00',
    request_identity_sha256: '1'.repeat(64),
    authority_context_sha256: '2'.repeat(64),
    prepared_at: '2026-09-05T00:00:01.123789+00:00',
  };
  const origin = {
    preparation_origin_id: randomUUID(),
    prepared_command_id: prepared.prepared_command_id,
    proposal_id: lease.proposal_id,
    recovery_lease_id: lease.recovery_lease_id,
    lease_owner_id: lease.lease_owner_id,
    witness_request_sha256: lease.witness_request_sha256,
    target_authority_id: lease.target_authority_id,
    release_manifest_sha256: authority.manifestDigest,
    service_database_role: authority.serviceLogin,
    provider_request_sha256: durable.providerRequestSha256,
    prepared_authority_sha256: prepared.authority_context_sha256,
    created_prepared: true,
    preparation_transaction_id: '18446744073709551614',
    recorded_at: '2026-09-05T00:00:01.123999+00:00',
  };
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: lease.target_authority_id,
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const preparation: Record<string, unknown> = {
    prepared_command: prepared,
    idempotency_replayed: false,
    worker_provenance: origin,
    requested_command: null,
    canonical_provider_request: durable.canonicalRequestJson,
    target_authority_id: lease.target_authority_id,
    release_manifest_digest: authority.manifestDigest,
  };
  const input = {
    operationKind: 'ADJUST' as const,
    operationId: request.operationId,
    providerKind: 'FAKE' as const,
    idempotencyKey: request.idempotencyKey,
    providerExpectedVersion: 0,
    exactRequest: durable.request,
    evidence: {
      preparedFinancialCommandId: prepared.prepared_command_id,
      preparedAuthoritySha256: prepared.authority_context_sha256,
      taskDraftId: prepared.task_draft_id,
      taskId: prepared.task_id,
      workOrderId: prepared.work_order_id,
      relatedOperationId: request.relatedOperationId,
      amountCents: prepared.amount_cents,
      currency: prepared.currency,
    },
    actor: { actorId: prepared.recorded_by, actorKind: 'PARTICIPANT' as const },
    release: {
      manifestDigest: authority.manifestDigest,
      releaseId: authority.releaseId,
      revision: authority.revision,
      environment: authority.environment,
      authenticationStatus: authority.authenticationStatus,
    },
  };
  const expected = prepareFinancialProviderCommand(input);
  const requested = {
    command_id: randomUUID(),
    operation_kind: 'ADJUST',
    operation_id: request.operationId,
    provider_kind: 'FAKE',
    idempotency_key: request.idempotencyKey,
    provider_expected_version: '0',
    request_sha256: durable.providerRequestSha256,
    command_identity_sha256: expected.commandIdentitySha256,
    prepared_financial_command_id: prepared.prepared_command_id,
    prepared_authority_sha256: prepared.authority_context_sha256,
    recorded_at: new Date('2026-09-05T00:00:02Z'),
    idempotency_replayed: false,
  };
  const historicalRelease = {
    ...input.release,
    manifestDigest: 'sha256:' + '9'.repeat(64),
    revision: 'd'.repeat(40),
    releaseId: 'synthetic.api.adjustment',
  };
  const historical = {
    ...requested,
    provider_expected_version: 0,
    recorded_at: '2026-09-05T00:00:02.123999+00:00',
    command_state: 'REQUESTED',
    requested_transaction_id: '18446744073709551614',
    task_draft_id: prepared.task_draft_id,
    task_id: prepared.task_id,
    work_order_id: prepared.work_order_id,
    related_operation_id: prepared.related_operation_id,
    amount_cents: 8000,
    currency: 'USD',
    recorded_actor_id: prepared.recorded_by,
    recorded_actor_kind: 'PARTICIPANT',
    release_manifest_digest: historicalRelease.manifestDigest,
    release_id: historicalRelease.releaseId,
    release_revision: historicalRelease.revision,
    release_environment: 'local',
    release_authentication_status: 'VERIFIED',
    command_identity_sha256: prepareFinancialProviderCommand({
      ...input,
      release: historicalRelease,
    }).commandIdentitySha256,
  };
  const { idempotency_replayed: unused, ...historicalRow } = historical;
  void unused;
  const row = (value: unknown) => ({ rowCount: 1, rows: [value] });
  const responses = [row(metadata), row(preparation), row(metadata), row(requested)];
  const query = vi.fn(async () => {
    const result = responses.shift();
    if (!result) throw Error('UNEXPECTED_QUERY');
    return result;
  });
  let commits = 0,
    rollbacks = 0;
  let afterCommit: () => void = () => {};
  const database: Pick<Database, 'transaction'> = {
    transaction: async (work) => {
      let result;
      try {
        result = await work(query as QueryFn);
      } catch (error) {
        rollbacks++;
        throw error;
      }
      commits++;
      afterCommit();
      return result;
    },
  };
  const authorize = vi.fn(() => authority);
  return {
    authority,
    lease,
    prepared,
    origin,
    preparation,
    requested,
    historicalRow,
    responses,
    query,
    database,
    authorize,
    port: new PostgresUniversalV1WorkerChangeOrderAdjustments(database, authorize),
    commits: () => commits,
    rollbacks: () => rollbacks,
    afterCommit: (action: () => void) => {
      afterCommit = action;
    },
  };
}

describe('worker change order adjustment adapter', () => {
  it('rejects incomplete lease evidence before opening a transaction', async () => {
    const transaction = vi.fn();
    const authorize = vi.fn(() => {
      throw Error('UNEXPECTED_AUTHORIZATION');
    });
    const port = new PostgresUniversalV1WorkerChangeOrderAdjustments(
      { transaction } as Pick<Database, 'transaction'>,
      authorize
    );
    await expect(port.requestAdjustment({} as never)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it('commits preparation before requesting the same adjustment and preserves timestamp precision', async () => {
    const f = fixture();
    const receipt = await f.port.requestAdjustment(f.lease);
    expect(receipt).toMatchObject({
      commandId: f.requested.command_id,
      requestState: 'REQUESTED',
      proposalId: f.lease.proposal_id,
      preparedAt: f.prepared.prepared_at,
      workerProvenance: f.origin,
      idempotencyReplayed: false,
    });
    expect(f.commits()).toBe(2);
    expect(f.rollbacks()).toBe(0);
    expect(Object.isFrozen(receipt.workerProvenance)).toBe(true);
    const call = f.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(call[0]).toContain('hxos_prepare_worker_change_order_adjustment_v13');
    expect(call[1].at(-1)).toBeNull();
  });
  it('returns the exact historical API request after expiry without rebuilding the worker release identity', async () => {
    const f = fixture('RETRY');
    f.preparation.requested_command = f.historicalRow;
    f.preparation.worker_provenance = null;
    f.preparation.idempotency_replayed = true;
    f.lease.expires_at = '2026-09-05T00:00:00.001Z';
    const result = await f.port.requestAdjustment(f.lease);
    expect(result).toMatchObject({
      commandId: f.historicalRow.command_id,
      commandIdentitySha256: f.historicalRow.command_identity_sha256,
      requestedAt: f.historicalRow.recorded_at,
      idempotencyReplayed: true,
      workerProvenance: null,
    });
    expect(f.commits()).toBe(1);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('refuses a mismatched original journal identity without requesting again', async () => {
    const f = fixture();
    f.preparation.requested_command = { ...f.historicalRow, recorded_actor_id: randomUUID() };
    f.preparation.idempotency_replayed = true;
    await expect(f.port.requestAdjustment(f.lease)).rejects.toThrow(/HISTORICAL_REQUEST_MISMATCH/u);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('rolls back mismatched lease provenance', async () => {
    const f = fixture();
    f.origin.recovery_lease_id = randomUUID();
    await expect(f.port.requestAdjustment(f.lease)).rejects.toThrow(/PROVENANCE_BINDING_MISMATCH/u);
    expect(f.commits()).toBe(0);
    expect(f.rollbacks()).toBe(1);
  });
  it('stops after committed preparation when installed authority changes', async () => {
    const f = fixture();
    f.afterCommit(() => {
      f.authority.revision = 'f'.repeat(40);
    });
    await expect(f.port.requestAdjustment(f.lease)).rejects.toThrow(/AUTHORITY_CHANGED/u);
    expect(f.commits()).toBe(1);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('propagates uncertain PREPARED acknowledgement without issuing a request', async () => {
    const f = fixture();
    f.afterCommit(() => {
      throw Error('PREPARED_COMMIT_ACK_LOST');
    });
    await expect(f.port.requestAdjustment(f.lease)).rejects.toThrow('PREPARED_COMMIT_ACK_LOST');
    expect(f.commits()).toBe(1);
    expect(f.rollbacks()).toBe(0);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
});
