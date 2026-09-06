import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database, QueryFn } from '../../src/db.js';
import { encodeFakeFinancialDurableRequest } from '../../src/services/payment/FakeFinancialDurableRequest.js';
import { prepareFinancialProviderCommand } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import type { ChangeOrderCompensationWinnerReceipt } from '../../src/services/UniversalV1ChangeOrderRecoveryCompensation.js';
import {
  PostgresUniversalV1ChangeOrderReversalRequests,
  authorizedChangeOrderReversalRequests,
} from '../../src/services/payment/UniversalV1ChangeOrderReversalRequest.js';
import * as financialAuthorization from '../../src/services/payment/NonproductionFinancialAuthorization.js';
import * as manifestAuthority from '../../src/releaseManifest.js';
import * as databaseStartup from '../../src/jobs/runtime-database-startup-config.js';

function fixture() {
  const authority = {
    databaseName: 'hx_ci_reversal',
    serviceLogin: 'hx_ci_worker',
    environment: 'local' as const,
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    targetDigest: 'sha256:' + 'b'.repeat(64),
    releaseId: 'synthetic.worker.reversal',
    revision: 'd'.repeat(40),
    authenticationStatus: 'VERIFIED' as const,
  };
  const command = {
    compensationCommandId: randomUUID(),
    proposalId: randomUUID(),
    witnessRequestSha256: 'c'.repeat(64),
    taskDraftId: randomUUID(),
    taskId: randomUUID(),
    eligibilityDecisionId: randomUUID(),
    baseScopeVersionId: randomUUID(),
    adjustmentEventId: randomUUID(),
    adjustmentOperationId: randomUUID(),
    reversalOperationId: randomUUID(),
    reversalIdempotencyKey: 'compensation:worker:reversal',
    lifecycleExpectedVersion: 4,
    amountCents: 8000,
    currency: 'USD',
    requestedBy: randomUUID(),
    createdAt: '2026-09-05T00:00:01.123456+00:00',
    semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED' as const,
  };
  const origin = {
    compensation_command_id: command.compensationCommandId,
    proposal_id: command.proposalId,
    recovery_lease_id: randomUUID(),
    lease_owner_id: randomUUID(),
    target_authority_id: randomUUID(),
    release_environment: 'local' as const,
    release_manifest_digest: 'sha256:' + 'e'.repeat(64),
    service_database_role: 'hx_previous_worker',
    witness_request_sha256: command.witnessRequestSha256,
    adjustment_event_id: command.adjustmentEventId,
    revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED' as const,
    recorded_at: '2026-09-05T00:00:01.123789+00:00',
  };
  const winner = {
    resolution: { kind: 'COMPENSATE' as const, command },
    workerOrigin: origin,
    created: true,
    observedAt: '2026-09-05T00:00:02.123456+00:00',
  };
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: randomUUID(),
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const durable = encodeFakeFinancialDurableRequest('REVERSAL', {
    operationId: command.reversalOperationId,
    idempotencyKey: command.reversalIdempotencyKey,
    expectedVersion: 0,
    relatedOperationId: command.adjustmentOperationId,
    amountCents: command.amountCents,
    currency: 'usd',
    scenario: 'REVERSAL',
  });
  const prepared = {
    prepared_command_id: randomUUID(),
    command_state: 'PREPARED',
    operation_kind: 'REVERSAL',
    event_kind: 'REVERSED',
    operation_id: command.reversalOperationId,
    provider_kind: 'FAKE',
    idempotency_key: command.reversalIdempotencyKey,
    provider_expected_version: 0,
    lifecycle_expected_version: command.lifecycleExpectedVersion,
    provider_request_sha256: durable.providerRequestSha256,
    task_draft_id: command.taskDraftId,
    task_id: command.taskId,
    eligibility_decision_id: command.eligibilityDecisionId,
    eligibility_decision_version: 1,
    eligibility_valid_until: '2026-09-05T00:01:00+00:00',
    scope_version_id: command.baseScopeVersionId,
    scope_version: 1,
    scope_hash: 'f'.repeat(64),
    work_order_id: randomUUID(),
    work_order_materialization_version: 1,
    work_order_execution_contract_version: 1,
    change_order_id: null,
    change_order_version: null,
    predecessor_event_id: command.adjustmentEventId,
    predecessor_operation_id: command.adjustmentOperationId,
    predecessor_event_kind: 'ADJUSTMENT_AUTHORIZED',
    predecessor_status: 'SUCCEEDED',
    predecessor_lifecycle_version: command.lifecycleExpectedVersion - 1,
    completion_fact_id: null,
    completion_version: null,
    related_operation_id: command.adjustmentOperationId,
    amount_cents: command.amountCents,
    currency: 'USD',
    recorded_by: command.requestedBy,
    occurred_at: '2026-09-05T00:00:03.123456+00:00',
    request_identity_sha256: '1'.repeat(64),
    authority_context_sha256: '2'.repeat(64),
    prepared_at: '2026-09-05T00:00:03.123789+00:00',
  };
  const provenance = {
    prepared_command_id: prepared.prepared_command_id,
    compensation_command_id: command.compensationCommandId,
    target_authority_id: metadata.target_authority_id,
    release_manifest_sha256: authority.manifestDigest,
    service_database_role: authority.serviceLogin,
    provider_request_sha256: durable.providerRequestSha256,
    prepared_authority_sha256: prepared.authority_context_sha256,
    preparation_transaction_id: '18446744073709551614',
    recorded_at: '2026-09-05T00:00:03.123999+00:00',
  };
  const preparation = {
    prepared_command: prepared,
    worker_provenance: provenance,
    idempotency_replayed: false,
    target_authority_id: metadata.target_authority_id,
    release_manifest_digest: authority.manifestDigest,
  };
  const expected = prepareFinancialProviderCommand({
    operationKind: 'REVERSAL',
    operationId: command.reversalOperationId,
    providerKind: 'FAKE',
    idempotencyKey: command.reversalIdempotencyKey,
    providerExpectedVersion: 0,
    exactRequest: durable.request,
    evidence: {
      preparedFinancialCommandId: prepared.prepared_command_id,
      preparedAuthoritySha256: prepared.authority_context_sha256,
      taskDraftId: command.taskDraftId,
      taskId: command.taskId,
      workOrderId: prepared.work_order_id,
      relatedOperationId: command.adjustmentOperationId,
      amountCents: command.amountCents,
      currency: 'USD',
    },
    actor: { actorId: command.requestedBy, actorKind: 'PARTICIPANT' },
    release: {
      manifestDigest: authority.manifestDigest,
      releaseId: authority.releaseId,
      revision: authority.revision,
      environment: authority.environment,
      authenticationStatus: 'VERIFIED',
    },
  });
  const requested = {
    command_id: randomUUID(),
    operation_kind: 'REVERSAL',
    operation_id: command.reversalOperationId,
    provider_kind: 'FAKE',
    idempotency_key: command.reversalIdempotencyKey,
    provider_expected_version: '0',
    request_sha256: durable.providerRequestSha256,
    command_identity_sha256: expected.commandIdentitySha256,
    prepared_financial_command_id: prepared.prepared_command_id,
    prepared_authority_sha256: prepared.authority_context_sha256,
    recorded_at: new Date('2026-09-05T00:00:04Z'),
    idempotency_replayed: false,
  };
  const row = (value: unknown) => ({ rows: [value], rowCount: 1 });
  const responses = [row(metadata), row(preparation), row({ ...metadata }), row(requested)];
  const events: string[] = [];
  let depth = 0,
    commits = 0,
    rollbacks = 0;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    events.push(
      sql.includes('hxos_request_fake_financial_command')
        ? 'REQUESTED'
        : sql.includes('hxos_prepare_change_order')
          ? 'PREPARED'
          : 'METADATA'
    );
    const response = responses.shift();
    if (!response) throw Error('UNEXPECTED_QUERY');
    return response;
  });
  const transaction: Database['transaction'] = async (work) => {
    if (depth) throw Error('NESTED_TRANSACTION');
    depth++;
    events.push('BEGIN');
    try {
      const result = await work(query as QueryFn);
      commits++;
      events.push('COMMIT');
      return result;
    } catch (error) {
      rollbacks++;
      events.push('ROLLBACK');
      throw error;
    } finally {
      depth--;
    }
  };
  const authorize = vi.fn(() => ({ ...authority }));
  const port = new PostgresUniversalV1ChangeOrderReversalRequests({ transaction }, authorize);
  return {
    authority,
    command,
    origin,
    winner,
    metadata,
    durable,
    prepared,
    provenance,
    preparation,
    expected,
    requested,
    responses,
    query,
    events,
    authorize,
    port,
    transaction,
    state: () => ({ commits, rollbacks }),
  };
}

describe('committed worker-origin reversal requests', () => {
  it('derives exact canonical bytes, commits PREPARED before REQUESTED, and preserves historical attribution', async () => {
    const f = fixture();
    const result = await f.port.requestReversal(f.winner);
    expect(f.events).toEqual([
      'BEGIN',
      'METADATA',
      'PREPARED',
      'COMMIT',
      'BEGIN',
      'METADATA',
      'REQUESTED',
      'COMMIT',
    ]);
    expect(f.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('hxos_prepare_change_order_compensation_reversal_v13'),
      [
        f.metadata.target_authority_id,
        f.authority.databaseName,
        'local',
        f.authority.manifestDigest,
        f.command.compensationCommandId,
        f.durable.canonicalRequestJson,
      ]
    );
    expect(f.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('hxos_request_fake_financial_command_v13'),
      [f.durable.canonicalRequestJson, f.expected.canonicalCommandIdentityJson]
    );
    expect(result).toEqual({
      requestState: 'REQUESTED',
      commandId: f.requested.command_id,
      preparedCommandId: f.prepared.prepared_command_id,
      compensationCommandId: f.command.compensationCommandId,
      operationId: f.command.reversalOperationId,
      requestedAt: f.requested.recorded_at.toISOString(),
      preparedAt: f.prepared.prepared_at,
      providerRequestSha256: f.durable.providerRequestSha256,
      preparedAuthoritySha256: f.prepared.authority_context_sha256,
      commandIdentitySha256: f.expected.commandIdentitySha256,
      preparationReplayed: false,
      idempotencyReplayed: false,
      workerProvenance: f.provenance,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.workerProvenance)).toBe(true);
    expect(f.state()).toEqual({ commits: 2, rollbacks: 0 });
  });

  it.each(['legacy winner', 'amendment winner', 'caller fields', 'unbound origin'])(
    'rejects %s before opening a transaction',
    async (fault) => {
      const f = fixture();
      const input: unknown =
        fault === 'legacy winner'
          ? { ...f.winner, workerOrigin: null }
          : fault === 'amendment winner'
            ? {
                ...f.winner,
                resolution: {
                  kind: 'AMENDMENT_MATERIALIZED',
                  amendmentId: randomUUID(),
                  adjustmentEventId: f.command.adjustmentEventId,
                },
              }
            : fault === 'caller fields'
              ? { ...f.winner, scenario: 'DECLINED' }
              : {
                  ...f.winner,
                  workerOrigin: { ...f.origin, compensation_command_id: randomUUID() },
                };
      await expect(
        f.port.requestReversal(input as ChangeOrderCompensationWinnerReceipt)
      ).rejects.toThrow();
      expect(f.events).toEqual([]);
      expect(f.query).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['operation_kind', 'REFUND'],
    ['event_kind', 'CAPTURED'],
    ['provider_kind', 'STRIPE'],
    ['operation_id', randomUUID()],
    ['provider_expected_version', 1],
    ['lifecycle_expected_version', 5],
    ['provider_request_sha256', '9'.repeat(64)],
    ['task_draft_id', randomUUID()],
    ['task_id', randomUUID()],
    ['eligibility_decision_id', randomUUID()],
    ['scope_version_id', randomUUID()],
    ['scope_hash', null],
    ['work_order_id', null],
    ['work_order_execution_contract_version', 2],
    ['change_order_id', randomUUID()],
    ['predecessor_event_id', randomUUID()],
    ['predecessor_operation_id', randomUUID()],
    ['predecessor_status', 'DECLINED'],
    ['predecessor_lifecycle_version', 4],
    ['completion_fact_id', randomUUID()],
    ['related_operation_id', randomUUID()],
    ['amount_cents', 7999],
    ['currency', 'usd'],
    ['recorded_by', randomUUID()],
    ['authority_context_sha256', '3'.repeat(64)],
    ['unexpected', true],
  ])('rolls back substituted PREPARED %s', async (field, value) => {
    const f = fixture();
    Object.assign(f.prepared, { [field]: value });
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow();
    expect(f.state()).toEqual({ commits: 0, rollbacks: 1 });
    expect(f.events).not.toContain('REQUESTED');
  });

  it.each([
    ['prepared_command_id', randomUUID()],
    ['compensation_command_id', randomUUID()],
    ['target_authority_id', randomUUID()],
    ['release_manifest_sha256', 'sha256:' + '9'.repeat(64)],
    ['service_database_role', 'hx_api'],
    ['provider_request_sha256', '3'.repeat(64)],
    ['prepared_authority_sha256', '3'.repeat(64)],
    ['preparation_transaction_id', 123],
    ['unexpected', true],
  ])('rolls back substituted worker preparation provenance %s', async (field, value) => {
    const f = fixture();
    Object.assign(f.provenance, { [field]: value });
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow();
    expect(f.state()).toEqual({ commits: 0, rollbacks: 1 });
  });

  it.each([0, 1, 2])(
    'rejects incorrect preparation cardinality variant %s before commit',
    async (variant) => {
      const f = fixture();
      if (variant === 0) f.responses[1] = { rows: [], rowCount: 0 };
      if (variant === 1) f.responses[1].rowCount = 0;
      if (variant === 2) f.responses[1] = { rows: [f.preparation, f.preparation], rowCount: 2 };
      await expect(f.port.requestReversal(f.winner)).rejects.toThrow('RECEIPT_CARDINALITY');
      expect(f.state()).toEqual({ commits: 0, rollbacks: 1 });
    }
  );

  it.each([
    'session_database_role',
    'target_database_name',
    'environment',
    'release_manifest_sha256',
  ])('rejects mismatched runtime %s before PREPARED', async (field) => {
    const f = fixture();
    Object.assign(f.metadata, { [field]: field === 'environment' ? 'staging' : 'different' });
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow();
    expect(f.events).not.toContain('PREPARED');
    expect(f.state()).toEqual({ commits: 0, rollbacks: 1 });
  });

  it('refuses a database target rollover between the two commits', async () => {
    const f = fixture();
    f.responses[2].rows = [{ ...f.metadata, target_authority_id: randomUUID() }];
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow('TARGET_BINDING_MISMATCH');
    expect(f.state()).toEqual({ commits: 1, rollbacks: 1 });
    expect(f.events).not.toContain('REQUESTED');
  });

  it.each(['PREPARED', 'REQUESTED'])(
    'rolls back %s when installed authority changes during SQL',
    async (phase) => {
      const f = fixture();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, params) => {
        const result = await original(sql, params);
        if (
          sql.includes(
            phase === 'PREPARED'
              ? 'hxos_prepare_change_order'
              : 'hxos_request_fake_financial_command'
          )
        ) {
          f.authority.targetDigest = 'sha256:' + '9'.repeat(64);
        }
        return result;
      });
      await expect(f.port.requestReversal(f.winner)).rejects.toThrow('RELEASE_AUTHORITY_CHANGED');
      expect(f.state()).toEqual({ commits: phase === 'PREPARED' ? 0 : 1, rollbacks: 1 });
    }
  );

  it.each([
    ['operation_kind', 'REFUND'],
    ['operation_id', randomUUID()],
    ['provider_kind', 'STRIPE'],
    ['idempotency_key', 'another:valid:operation'],
    ['provider_expected_version', '1'],
    ['prepared_financial_command_id', randomUUID()],
    ['prepared_authority_sha256', '9'.repeat(64)],
    ['command_id', 'invalid'],
    ['idempotency_replayed', 'true'],
    ['provider_expected_version', null],
    ['provider_expected_version', false],
    ['provider_expected_version', ''],
    ['recorded_at', null],
    ['recorded_at', 0],
    ['unexpected', true],
  ])('validates REQUESTED %s before its commit', async (field, value) => {
    const f = fixture();
    Object.assign(f.requested, { [field]: value });
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow();
    expect(f.state()).toEqual({ commits: 1, rollbacks: 1 });
  });

  it('rolls back a REQUESTED cardinality mismatch before the journal maps its row', async () => {
    const f = fixture();
    f.responses[3].rowCount = 0;
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow('REQUEST_CARDINALITY');
    expect(f.state()).toEqual({ commits: 1, rollbacks: 1 });
  });

  it('retains preparation and request replay flags independently', async () => {
    const f = fixture();
    f.preparation.idempotency_replayed = true;
    f.requested.idempotency_replayed = true;
    expect(await f.port.requestReversal(f.winner)).toMatchObject({
      preparationReplayed: true,
      idempotencyReplayed: true,
    });
  });

  it('leaves committed PREPARED resumable when REQUESTED fails without inventing a financial effect', async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes('hxos_request_fake_financial_command'))
        throw Error('HXUV1-COREVERSAL-13-REQUEST_LOCK_BUSY');
      return original(sql, params);
    });
    await expect(f.port.requestReversal(f.winner)).rejects.toThrow('REQUEST_LOCK_BUSY');
    expect(f.state()).toEqual({ commits: 1, rollbacks: 1 });
    expect(f.events).not.toContain('REQUESTED');
  });
});

describe('installed worker reversal request authority', () => {
  it.each(['valid', 'unsigned', 'different digest', 'different environment'] as const)(
    'validates %s installed release before any database work',
    (fault) => {
      const f = fixture();
      const spies = [
        vi
          .spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized')
          .mockReturnValue({
            releaseId: f.authority.releaseId,
            environment: f.authority.environment,
            components: {
              backend: { revision: 'c'.repeat(40) },
              worker: { revision: f.authority.revision },
            },
          } as ReturnType<typeof financialAuthorization.assertNonproductionFakeFinanceAuthorized>),
        vi
          .spyOn(manifestAuthority, 'releaseManifestDigest')
          .mockReturnValue(f.authority.manifestDigest),
        vi.spyOn(manifestAuthority, 'readReleaseManifest').mockReturnValue({
          digest:
            fault === 'different digest' ? 'sha256:' + '9'.repeat(64) : f.authority.manifestDigest,
        } as ReturnType<typeof manifestAuthority.readReleaseManifest>),
        vi
          .spyOn(manifestAuthority, 'isAuthenticatedReleaseManifest')
          .mockReturnValue(fault !== 'unsigned'),
        vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
          expectedTarget: {
            databaseName: f.authority.databaseName,
            environment: fault === 'different environment' ? 'staging' : 'local',
          },
          target: { serviceLogin: f.authority.serviceLogin },
          targetDigest: f.authority.targetDigest,
        } as ReturnType<typeof databaseStartup.configuredRuntimeDatabaseStartup>),
      ];
      try {
        if (fault === 'valid') {
          const result = authorizedChangeOrderReversalRequests();
          expect(result).toEqual(f.authority);
          expect(Object.isFrozen(result)).toBe(true);
          expect(
            financialAuthorization.assertNonproductionFakeFinanceAuthorized
          ).toHaveBeenCalledWith({ component: 'worker' });
          expect(databaseStartup.configuredRuntimeDatabaseStartup).toHaveBeenCalledWith('worker');
        } else {
          expect(authorizedChangeOrderReversalRequests).toThrow(
            fault === 'different environment'
              ? 'WORKER_RELEASE_REQUIRED'
              : 'AUTHENTICATED_RELEASE_REQUIRED'
          );
        }
        expect(f.query).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
  );
});
