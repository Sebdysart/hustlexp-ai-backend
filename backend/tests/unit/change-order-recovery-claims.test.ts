import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import { PostgresUniversalV1ChangeOrderRecoveryClaims } from '../../src/services/UniversalV1ChangeOrderRecoveryClaims.js';
function fixture() {
  const input = {
    leaseOwnerId: randomUUID(),
    limit: 2,
    leaseDurationSeconds: 300,
    minimumAgeSeconds: 5,
  };
  const authority = {
    databaseName: 'hx_ci_recovery_test',
    serviceLogin: 'hx_ci_worker',
    environment: 'local' as const,
    manifestDigest: 'sha256:' + 'b'.repeat(64),
    targetDigest: 'sha256:' + 'a'.repeat(64),
  };
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: randomUUID(),
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const row = {
    proposal_id: randomUUID(),
    recovery_lease_id: randomUUID(),
    lease_owner_id: input.leaseOwnerId,
    witness_request_sha256: 'c'.repeat(64),
    work_order_id: randomUUID(),
    acquired_at: new Date('2026-09-05T00:00:00.123Z'),
    expires_at: new Date('2026-09-05T00:05:00.123Z'),
    target_authority_id: metadata.target_authority_id,
    release_manifest_digest: authority.manifestDigest,
  };
  const responses = [
    { rows: [metadata], rowCount: 1 },
    { rows: [row], rowCount: 1 },
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
  const repo = new PostgresUniversalV1ChangeOrderRecoveryClaims({ transaction }, authorize);
  return {
    input,
    authority,
    metadata,
    row,
    responses,
    query,
    authorize,
    repo,
    state: () => ({ committed, rolledBack }),
  };
}
describe('worker change order recovery claim decoder', () => {
  it('binds the installed worker and validates immutable lease receipts before commit', async () => {
    const f = fixture();
    const rows = await f.repo.claimDue(f.input);
    expect(rows).toHaveLength(1);
    expect(rows[0].acquired_at).toBe('2026-09-05T00:00:00.123Z');
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1]).toEqual([
      'SELECT * FROM public.hxos_claim_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        f.metadata.target_authority_id,
        f.authority.databaseName,
        'local',
        f.authority.manifestDigest,
        f.input.leaseOwnerId,
        2,
        300,
        5,
      ],
    ]);
    expect(f.state()).toEqual({ committed: true, rolledBack: false });
  });
  it('accepts an empty due set without inventing work', async () => {
    const f = fixture();
    f.responses[1] = { rows: [], rowCount: 0 };
    expect(await f.repo.claimDue(f.input)).toEqual([]);
  });
  it.each(['owner', 'target', 'release', 'duration', 'duplicate', 'cardinality', 'extra'] as const)(
    'rolls back a malformed %s receipt',
    async (kind) => {
      const f = fixture();
      if (kind === 'owner') f.row.lease_owner_id = randomUUID();
      if (kind === 'target') f.row.target_authority_id = randomUUID();
      if (kind === 'release') f.row.release_manifest_digest = 'sha256:' + 'd'.repeat(64);
      if (kind === 'duration') f.row.expires_at = new Date('2026-09-05T00:05:01.123Z');
      if (kind === 'duplicate') f.responses[1] = { rows: [f.row, f.row], rowCount: 2 };
      if (kind === 'cardinality') f.responses[1].rowCount = 0;
      if (kind === 'extra') Object.assign(f.row, { execute_authorized: true });
      await expect(f.repo.claimDue(f.input)).rejects.toThrow();
      expect(f.state()).toEqual({ committed: false, rolledBack: true });
    }
  );
  it.each(['login', 'database', 'environment', 'manifest', 'cardinality'] as const)(
    'rejects wrong %s metadata before acquiring a lease',
    async (kind) => {
      const f = fixture();
      if (kind === 'login') f.metadata.session_database_role = 'hx_ci_api';
      if (kind === 'database') f.metadata.target_database_name = 'another_database';
      if (kind === 'environment') Object.assign(f.metadata, { environment: 'staging' });
      if (kind === 'manifest') f.metadata.release_manifest_sha256 = 'sha256:' + 'd'.repeat(64);
      if (kind === 'cardinality') f.responses[0].rowCount = 0;
      await expect(f.repo.claimDue(f.input)).rejects.toThrow();
      expect(f.query).toHaveBeenCalledTimes(1);
      expect(f.state().rolledBack).toBe(true);
    }
  );
  it.each(['manifestDigest', 'targetDigest'] as const)(
    'rolls back when installed %s changes during the transaction',
    async (key) => {
      const f = fixture();
      f.authorize
        .mockReturnValueOnce(f.authority)
        .mockReturnValue({ ...f.authority, [key]: 'sha256:' + 'e'.repeat(64) });
      await expect(f.repo.claimDue(f.input)).rejects.toThrow('RELEASE_AUTHORITY_CHANGED');
      expect(f.state()).toEqual({ committed: false, rolledBack: true });
    }
  );
  it.each([
    { limit: 0 },
    { limit: 101 },
    { leaseDurationSeconds: 4 },
    { leaseDurationSeconds: 901 },
    { minimumAgeSeconds: 4 },
    { minimumAgeSeconds: 3601 },
    { leaseOwnerId: 'invalid' },
    { actorAssertion: 'forged' },
  ])('rejects invalid input before database work: %j', async (override) => {
    const f = fixture();
    await expect(f.repo.claimDue({ ...f.input, ...override })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});
