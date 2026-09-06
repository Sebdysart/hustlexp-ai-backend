import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import { PostgresUniversalV1ChangeOrderRecoveryObservation } from '../../src/services/UniversalV1ChangeOrderRecoveryObservation.js';

function fixture() {
  const authority = {
    databaseName: 'hx_ci_observation',
    serviceLogin: 'hx_ci_worker',
    environment: 'local' as const,
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    targetDigest: 'sha256:' + 'b'.repeat(64),
  };
  const lease = {
    proposal_id: randomUUID(),
    recovery_lease_id: randomUUID(),
    lease_owner_id: randomUUID(),
    witness_request_sha256: 'c'.repeat(64),
    work_order_id: randomUUID(),
    acquired_at: '2026-09-05T00:00:00.000Z',
    expires_at: '2026-09-05T00:05:00.000Z',
    target_authority_id: randomUUID(),
    release_manifest_digest: authority.manifestDigest,
  };
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: lease.target_authority_id,
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const observation = {
    proposal_id: lease.proposal_id,
    recovery_lease_id: lease.recovery_lease_id,
    lease_owner_id: lease.lease_owner_id,
    work_order_id: lease.work_order_id,
    request_sha256: lease.witness_request_sha256,
    recovery_state: 'ADJUST_RECONCILE_ONLY',
    idempotency_key: 'observation:exact:key',
    actor_user_id: randomUUID(),
    task_id: randomUUID(),
    task_draft_id: randomUUID(),
    eligibility_decision_id: randomUUID(),
    base_scope_version_id: randomUUID(),
    replacement_scope_version_id: randomUUID(),
    replacement_scope_version: 2,
    expected_financial_version: 2,
    predecessor_event_id: randomUUID(),
    predecessor_operation_id: randomUUID(),
    adjustment_operation_id: randomUUID(),
    customer_total_cents: 8000,
    currency: 'USD',
    occurred_at: '2026-09-04T23:59:00+00:00',
    adjustment_event_id: null,
    amendment_id: null,
    compensation_event_id: null,
    adjustment_outcome_fact_id: null,
    authority_revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
    compensation_command_id: null,
    compensation_reversal_operation_id: null,
    compensation_reversal_idempotency_key: null,
    compensation_lifecycle_expected_version: null,
    compensation_amount_cents: null,
    compensation_currency: null,
    compensation_requested_by: null,
    compensation_created_at: null,
    compensation_semantic_limitation: null,
  } as Record<string, unknown>;
  const receipt = {
    observation,
    observed_at: new Date('2026-09-05T00:00:01.123Z'),
    target_authority_id: lease.target_authority_id,
    release_manifest_digest: authority.manifestDigest,
  };
  const responses = [
    { rows: [metadata] as unknown[], rowCount: 1 },
    { rows: [receipt] as unknown[], rowCount: 1 },
  ];
  const query = vi.fn(async () => responses.shift()!);
  let committed = false,
    rolledBack = false;
  const transaction: Database['transaction'] = async (work) => {
    try {
      const result = await work(query as never);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const authorize = vi.fn(() => authority);
  return {
    authority,
    lease,
    metadata,
    observation,
    receipt,
    responses,
    query,
    authorize,
    reader: new PostgresUniversalV1ChangeOrderRecoveryObservation({ transaction }, authorize),
    state: () => ({ committed, rolledBack }),
  };
}

describe('restricted worker recovery observation', () => {
  it('binds the exact lease and drops unrelated revocation evidence when an admitted effect is unresolved', async () => {
    const f = fixture(),
      result = await f.reader.observe(f.lease);
    expect(result).toMatchObject({
      proposalId: f.lease.proposal_id,
      recoveryLeaseId: f.lease.recovery_lease_id,
      observation: 'ADJUST_RECONCILE_ONLY',
      authorityRevocationReason: null,
      adjustmentOutcomeFactId: null,
      occurredAt: '2026-09-04T23:59:00.000Z',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.query.mock.calls[1]).toEqual([
      'SELECT * FROM public.hxos_observe_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        f.lease.target_authority_id,
        f.authority.databaseName,
        'local',
        f.authority.manifestDigest,
        f.lease.proposal_id,
        f.lease.recovery_lease_id,
        f.lease.lease_owner_id,
        f.lease.witness_request_sha256,
        f.lease.work_order_id,
      ],
    ]);
    expect(f.state()).toEqual({ committed: true, rolledBack: false });
  });
  it.each([
    'ADJUST_READY',
    'ADJUST_REPLAYABLE',
    'ADJUST_TERMINAL_NO_EFFECT',
    'ADJUST_NO_EFFECT_AUTHORITY_REVOKED',
    'ADJUSTMENT_SUCCEEDED',
    'COMPENSATION_READY',
    'COMPENSATION_REPLAYABLE',
    'COMPENSATION_RECONCILE_ONLY',
    'COMPENSATION_TERMINAL_NO_EFFECT',
    'COMPENSATION_SUCCEEDED',
    'AMENDMENT_MATERIALIZED',
    'WAITING',
  ])('preserves the selected durable observation: %s', async (state) => {
    const f = fixture();
    f.observation.recovery_state = state;
    if (state === 'ADJUST_TERMINAL_NO_EFFECT')
      f.observation.adjustment_outcome_fact_id = randomUUID();
    if (
      state === 'ADJUSTMENT_SUCCEEDED' ||
      state === 'AMENDMENT_MATERIALIZED' ||
      state.startsWith('COMPENSATION_')
    )
      f.observation.adjustment_event_id = randomUUID();
    if (state === 'AMENDMENT_MATERIALIZED') f.observation.amendment_id = randomUUID();
    if (state === 'COMPENSATION_SUCCEEDED') f.observation.compensation_event_id = randomUUID();
    if (state.startsWith('COMPENSATION_'))
      Object.assign(f.observation, {
        compensation_command_id: randomUUID(),
        compensation_reversal_operation_id: randomUUID(),
        compensation_reversal_idempotency_key: 'compensation:exact:key',
        compensation_lifecycle_expected_version: 4,
        compensation_amount_cents: 8000,
        compensation_currency: 'USD',
        compensation_requested_by: randomUUID(),
        compensation_created_at: '2026-09-05T00:00:00.123456+00:00',
        compensation_semantic_limitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
      });
    const result = await f.reader.observe(f.lease);
    expect(result?.observation).toBe(state);
    if (result?.compensationCommand) expect(Object.isFrozen(result.compensationCommand)).toBe(true);
  });
  it.each([
    'proposal_id',
    'recovery_lease_id',
    'lease_owner_id',
    'work_order_id',
    'request_sha256',
  ])('rolls back a substituted witness or lease: %s', async (field) => {
    const f = fixture();
    f.observation[field] = field === 'request_sha256' ? 'e'.repeat(64) : randomUUID();
    await expect(f.reader.observe(f.lease)).rejects.toThrow('RECEIPT_BINDING_MISMATCH');
    expect(f.state()).toEqual({ committed: false, rolledBack: true });
  });
  it.each([
    'session_database_role',
    'target_database_name',
    'environment',
    'release_manifest_sha256',
    'target_authority_id',
  ])('rejects stale or wrong installed target metadata: %s', async (field) => {
    const f = fixture();
    Object.assign(f.metadata, {
      [field]:
        field === 'target_authority_id'
          ? randomUUID()
          : field === 'environment'
            ? 'staging'
            : field === 'release_manifest_sha256'
              ? 'sha256:' + 'f'.repeat(64)
              : 'wrong',
    });
    await expect(f.reader.observe(f.lease)).rejects.toThrow('TARGET_BINDING_MISMATCH');
    expect(f.query).toHaveBeenCalledOnce();
  });
  it.each(['empty', 'present'])(
    'rechecks installed authority before committing a %s observation',
    async (kind) => {
      const f = fixture();
      if (kind === 'empty') f.responses[1] = { rows: [], rowCount: 0 };
      f.authorize
        .mockReturnValueOnce(f.authority)
        .mockReturnValueOnce({ ...f.authority, targetDigest: 'sha256:' + 'e'.repeat(64) });
      await expect(f.reader.observe(f.lease)).rejects.toThrow('RELEASE_AUTHORITY_CHANGED');
      expect(f.state()).toEqual({ committed: false, rolledBack: true });
    }
  );
  it('returns no work when the database says the exact lease expired or terminalized', async () => {
    const f = fixture();
    f.responses[1] = { rows: [], rowCount: 0 };
    expect(await f.reader.observe(f.lease)).toBeNull();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    'missing_outcome',
    'missing_compensation',
    'partial_compensation',
    'unknown_field',
    'unsafe_amount',
    'expired_observation',
    'duplicate_receipt',
  ])('rejects incomplete or malformed recovery evidence: %s', async (defect) => {
    const f = fixture();
    if (defect === 'missing_outcome') f.observation.recovery_state = 'ADJUST_TERMINAL_NO_EFFECT';
    if (defect === 'missing_compensation') f.observation.recovery_state = 'COMPENSATION_READY';
    if (defect === 'partial_compensation') f.observation.compensation_amount_cents = 8000;
    if (defect === 'unknown_field') f.observation.dispatch_authorized = true;
    if (defect === 'unsafe_amount')
      f.observation.customer_total_cents = Number.MAX_SAFE_INTEGER + 1;
    if (defect === 'expired_observation') f.receipt.observed_at = new Date(f.lease.expires_at);
    if (defect === 'duplicate_receipt')
      f.responses[1] = { rows: [f.receipt, f.receipt], rowCount: 2 };
    await expect(f.reader.observe(f.lease)).rejects.toThrow();
    expect(f.state()).toEqual({ committed: false, rolledBack: true });
  });
});
