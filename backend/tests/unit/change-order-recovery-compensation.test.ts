import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import { PostgresUniversalV1ChangeOrderRecoveryCompensation } from '../../src/services/UniversalV1ChangeOrderRecoveryCompensation.js';

function fixture() {
  const authority = {
    databaseName: 'hx_ci_compensation',
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
    target_authority_id: randomUUID(),
    release_manifest_digest: authority.manifestDigest,
    acquired_at: '2026-09-05T00:00:00Z',
    expires_at: '2026-09-05T00:05:00Z',
  };
  const eventId = randomUUID();
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: lease.target_authority_id,
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const command: Record<string, unknown> = {
    compensation_command_id: randomUUID(),
    proposal_id: lease.proposal_id,
    witness_request_sha256: lease.witness_request_sha256,
    recovery_lease_id: lease.recovery_lease_id,
    lease_owner_id: lease.lease_owner_id,
    task_draft_id: randomUUID(),
    task_id: randomUUID(),
    work_order_id: lease.work_order_id,
    eligibility_decision_id: randomUUID(),
    base_scope_version_id: randomUUID(),
    adjustment_event_id: eventId,
    adjustment_operation_id: randomUUID(),
    reversal_operation_id: randomUUID(),
    reversal_idempotency_key: 'compensation:exact:reversal',
    lifecycle_expected_version: 4,
    amount_cents: 8000,
    currency: 'USD',
    requested_by: randomUUID(),
    reason_code: 'FINALIZATION_AUTHORITY_REVOKED',
    authority_revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
    semantic_limitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
    created_at: '2026-09-05T00:00:01.123456+00:00',
  };
  const origin: Record<string, unknown> = {
    compensation_command_id: command.compensation_command_id,
    proposal_id: lease.proposal_id,
    recovery_lease_id: lease.recovery_lease_id,
    lease_owner_id: lease.lease_owner_id,
    target_authority_id: lease.target_authority_id,
    release_environment: 'local',
    release_manifest_digest: authority.manifestDigest,
    service_database_role: authority.serviceLogin,
    witness_request_sha256: lease.witness_request_sha256,
    adjustment_event_id: eventId,
    revocation_reason: command.authority_revocation_reason,
    recorded_at: '2026-09-05T00:00:01.123789+00:00',
  };
  const resolution: Record<string, unknown> = {
    kind: 'COMPENSATE',
    command,
    workerOrigin: origin,
    created: true,
  };
  const receipt = {
    resolution,
    observed_at: new Date('2026-09-05T00:00:02Z'),
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
  const port = new PostgresUniversalV1ChangeOrderRecoveryCompensation({ transaction }, authorize);
  return {
    authority,
    lease,
    eventId,
    metadata,
    command,
    origin,
    resolution,
    receipt,
    responses,
    query,
    authorize,
    port,
    state: () => ({ committed, rolledBack }),
  };
}

describe('restricted worker compensation winner', () => {
  it('binds the exact worker lease and preserves participant and microsecond identities', async () => {
    const f = fixture(),
      result = await f.port.claim(f.lease, f.eventId);
    expect(f.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('hxos_claim_fake_financial_change_order_compensation_v13'),
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
        f.eventId,
      ]
    );
    expect(result).toMatchObject({
      created: true,
      resolution: {
        kind: 'COMPENSATE',
        command: {
          requestedBy: f.command.requested_by,
          createdAt: '2026-09-05T00:00:01.123456+00:00',
          semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
        },
      },
      workerOrigin: {
        service_database_role: f.authority.serviceLogin,
        recorded_at: '2026-09-05T00:00:01.123789+00:00',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.resolution)).toBe(true);
    expect(Object.isFrozen(result!.workerOrigin)).toBe(true);
    if (result!.resolution.kind === 'COMPENSATE')
      expect(Object.isFrozen(result!.resolution.command)).toBe(true);
    expect(f.state()).toEqual({ committed: true, rolledBack: false });
  });
  it('retains an amendment winner without inventing compensation', async () => {
    const f = fixture(),
      amendmentId = randomUUID();
    f.receipt.resolution = {
      kind: 'AMENDMENT_MATERIALIZED',
      amendmentId,
      adjustmentEventId: f.eventId,
    };
    expect(await f.port.claim(f.lease, f.eventId)).toMatchObject({
      created: false,
      workerOrigin: null,
      resolution: { kind: 'AMENDMENT_MATERIALIZED', amendmentId, adjustmentEventId: f.eventId },
    });
  });
  it('does not invent worker provenance for a legacy winner', async () => {
    const f = fixture();
    f.resolution.created = false;
    f.resolution.workerOrigin = null;
    expect(await f.port.claim(f.lease, f.eventId)).toMatchObject({
      created: false,
      workerOrigin: null,
      resolution: { kind: 'COMPENSATE' },
    });
  });
  it('keeps original winner lease and origin after a later release and recovery lease', async () => {
    const f = fixture();
    f.resolution.created = false;
    for (const field of ['recovery_lease_id', 'lease_owner_id'])
      f.origin[field] = f.command[field] = randomUUID();
    f.origin.target_authority_id = randomUUID();
    f.origin.release_manifest_digest = 'sha256:' + 'f'.repeat(64);
    f.origin.service_database_role = 'hx_ci_previous_worker';
    expect((await f.port.claim(f.lease, f.eventId))?.workerOrigin).toEqual(f.origin);
  });
  it('returns no winner for an expired or terminal lease and still rechecks authority', async () => {
    const f = fixture();
    f.responses[1] = { rows: [], rowCount: 0 };
    expect(await f.port.claim(f.lease, f.eventId)).toBeNull();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    'session_database_role',
    'target_database_name',
    'environment',
    'release_manifest_sha256',
    'target_authority_id',
  ])('rejects substituted target metadata: %s', async (field) => {
    const f = fixture();
    Object.assign(f.metadata, {
      [field]:
        field === 'environment'
          ? 'staging'
          : field === 'target_authority_id'
            ? randomUUID()
            : field === 'release_manifest_sha256'
              ? 'sha256:' + 'f'.repeat(64)
              : 'wrong',
    });
    await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow();
    expect(f.query).toHaveBeenCalledOnce();
  });
  it.each(['proposal_id', 'work_order_id', 'witness_request_sha256', 'adjustment_event_id'])(
    'rolls back a substituted winner identity: %s',
    async (field) => {
      const f = fixture();
      f.command[field] = field === 'witness_request_sha256' ? 'd'.repeat(64) : randomUUID();
      await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow('WINNER_BINDING_MISMATCH');
      expect(f.state()).toEqual({ committed: false, rolledBack: true });
    }
  );
  it.each([
    'compensation_command_id',
    'proposal_id',
    'recovery_lease_id',
    'lease_owner_id',
    'adjustment_event_id',
    'witness_request_sha256',
    'revocation_reason',
  ])('refuses mismatched immutable origin: %s', async (field) => {
    const f = fixture();
    f.origin[field] =
      field === 'witness_request_sha256'
        ? 'e'.repeat(64)
        : field === 'revocation_reason'
          ? 'PROVIDER_ACTOR_AUTHORITY_REVOKED'
          : randomUUID();
    await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow('ORIGIN_BINDING_MISMATCH');
  });
  it.each([
    'target_authority_id',
    'release_environment',
    'release_manifest_digest',
    'service_database_role',
    'missing_origin',
  ])('requires exact current origin for new creation: %s', async (field) => {
    const f = fixture();
    if (field === 'missing_origin') f.resolution.workerOrigin = null;
    else
      f.origin[field] =
        field === 'target_authority_id'
          ? randomUUID()
          : field === 'release_environment'
            ? 'staging'
            : field === 'release_manifest_digest'
              ? 'sha256:' + 'e'.repeat(64)
              : 'hx_ci_other_worker';
    await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow('NEW_WINNER_ORIGIN_MISMATCH');
  });
  it.each([
    'unsafe_amount',
    'unknown_field',
    'expired_receipt',
    'future_origin',
    'duplicate_receipt',
    'false_cardinality',
    'bad_amendment',
  ])('rejects malformed or incomplete receipt: %s', async (defect) => {
    const f = fixture();
    if (defect === 'unsafe_amount') f.command.amount_cents = Number.MAX_SAFE_INTEGER + 1;
    if (defect === 'unknown_field') f.resolution.dispatch_authorized = true;
    if (defect === 'expired_receipt') f.receipt.observed_at = new Date(f.lease.expires_at);
    if (defect === 'future_origin') f.origin.recorded_at = '2026-09-05T00:06:00Z';
    if (defect === 'duplicate_receipt')
      f.responses[1] = { rows: [f.receipt, f.receipt], rowCount: 2 };
    if (defect === 'false_cardinality') f.responses[1].rowCount = 0;
    if (defect === 'bad_amendment')
      f.receipt.resolution = {
        kind: 'AMENDMENT_MATERIALIZED',
        amendmentId: randomUUID(),
        adjustmentEventId: randomUUID(),
      };
    await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow();
    expect(f.state()).toEqual({ committed: false, rolledBack: true });
  });
  it.each(['empty', 'present'])('rechecks installed release before %s commit', async (state) => {
    const f = fixture();
    if (state === 'empty') f.responses[1] = { rows: [], rowCount: 0 };
    f.authorize
      .mockReturnValueOnce(f.authority)
      .mockReturnValueOnce({ ...f.authority, targetDigest: 'sha256:' + 'e'.repeat(64) });
    await expect(f.port.claim(f.lease, f.eventId)).rejects.toThrow('RELEASE_AUTHORITY_CHANGED');
    expect(f.state()).toEqual({ committed: false, rolledBack: true });
  });
  it('rejects malformed input before opening a transaction', async () => {
    const f = fixture();
    await expect(
      f.port.claim({ ...f.lease, witness_request_sha256: '0'.repeat(64) }, f.eventId)
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});
