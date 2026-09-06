import { describe, expect, it } from 'vitest';
import type { Database, QueryFn } from '../../src/db.js';
import {
  PostgresUniversalV1ChangeOrderRecoveryTerminals,
  type ChangeOrderTerminalCommand,
} from '../../src/services/UniversalV1ChangeOrderRecoveryTerminals.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const authority = {
  databaseName: 'hx_ci_terminal',
  serviceLogin: 'hx_ci_worker',
  environment: 'local' as const,
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  targetDigest: 'sha256:' + 'b'.repeat(64),
};
const lease = {
  proposal_id: id(1),
  recovery_lease_id: id(2),
  lease_owner_id: id(3),
  work_order_id: id(4),
  witness_request_sha256: 'c'.repeat(64),
  acquired_at: '2026-09-06T00:00:00.000Z',
  expires_at: '2026-09-06T00:05:00.000Z',
  target_authority_id: id(5),
  release_manifest_digest: authority.manifestDigest,
};
const command: ChangeOrderTerminalCommand = {
  kind: 'MATERIALIZED',
  lease,
  actorUserId: id(6),
  amendmentId: id(7),
  adjustmentEventId: id(8),
};
function fixture(input: ChangeOrderTerminalCommand = command, replay = false) {
  const metadata = {
    session_database_role: authority.serviceLogin,
    target_authority_id: id(5),
    target_database_name: authority.databaseName,
    environment: authority.environment,
    release_manifest_sha256: authority.manifestDigest,
  };
  const terminal = {
    terminal_fact_id: id(9),
    proposal_id: lease.proposal_id,
    witness_request_sha256: lease.witness_request_sha256,
    recovery_lease_id: lease.recovery_lease_id,
    lease_owner_id: lease.lease_owner_id,
    outcome_state: input.kind === 'MATERIALIZED' ? 'MATERIALIZED' : 'CANCELLED',
    recovery_state: input.kind === 'MATERIALIZED' ? 'NOT_REQUIRED' : 'RECOVERY_REQUIRED',
    amendment_id: input.kind === 'MATERIALIZED' ? input.amendmentId : null,
    adjustment_event_id: input.adjustmentEventId,
    compensation_command_id: input.kind === 'COMPENSATED' ? input.compensationCommandId : null,
    compensation_event_id: input.kind === 'COMPENSATED' ? input.compensationEventId : null,
    no_effect_outcome_fact_id: input.kind === 'NO_EFFECT' ? input.noEffectOutcomeFactId : null,
    authority_revocation_reason:
      input.kind === 'NO_EFFECT' ? input.authorityRevocationReason : null,
    resolution_evidence_kind:
      input.kind === 'MATERIALIZED'
        ? 'AMENDMENT'
        : input.kind === 'COMPENSATED'
          ? 'REVERSAL'
          : 'NO_EFFECT',
    hold_clearance_kind:
      input.kind === 'MATERIALIZED' ? 'EXACT_AMENDMENT' : 'BOUNDED_CANCELLATION_RECOVERY',
    execution_resume_authorized: input.kind === 'MATERIALIZED',
    prior_secured_state_restored: false,
    capture_resume_authorized: false,
    payment_creation_performed: false,
    hard_assignment_created: false,
    recorded_by: input.actorUserId,
    recorded_at: '2026-09-06T00:01:00.123456+00:00',
    terminal_fact_sha256: 'd'.repeat(64),
  };
  const receipt = {
    terminal_fact: terminal,
    idempotency_replayed: replay,
    observed_at: new Date(replay ? '2026-09-06T02:00:00Z' : '2026-09-06T00:01:01Z'),
    target_authority_id: metadata.target_authority_id,
    release_manifest_digest: authority.manifestDigest,
  };
  const calls: { sql: string; params?: unknown[] }[] = [];
  const events: string[] = [];
  let receiptRows: unknown[] = [receipt];
  let rowCount = 1;
  let authorizeCount = 0;
  let driftAt = Infinity;
  let commitLoss = false;
  const query: QueryFn = async <Row>(sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return sql.includes('hxos_read_universal_v1_fake_financial_runtime_authority_v13')
      ? { rows: [metadata] as Row[], rowCount: 1 }
      : { rows: receiptRows as Row[], rowCount };
  };
  const database: Pick<Database, 'transaction'> = {
    transaction: async (work) => {
      events.push('BEGIN');
      let result;
      try {
        result = await work(query);
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      }
      events.push('COMMIT');
      if (commitLoss) throw new Error('LOST_COMMIT_ACKNOWLEDGEMENT');
      return result;
    },
  };
  const adapter = new PostgresUniversalV1ChangeOrderRecoveryTerminals(database, () => ({
    ...authority,
    targetDigest: ++authorizeCount >= driftAt ? 'sha256:' + 'f'.repeat(64) : authority.targetDigest,
  }));
  return {
    adapter,
    terminal,
    metadata,
    receipt,
    calls,
    events,
    rows: (rows: unknown[], count = rows.length) => {
      receiptRows = rows;
      rowCount = count;
    },
    drift: (at: number) => {
      driftAt = at;
    },
    loseCommit: () => {
      commitLoss = true;
    },
  };
}

describe('worker change order terminal adapter', () => {
  it.each([
    command,
    {
      kind: 'COMPENSATED',
      lease,
      actorUserId: id(6),
      adjustmentEventId: id(8),
      compensationCommandId: id(10),
      compensationEventId: id(11),
    },
    {
      kind: 'NO_EFFECT',
      lease,
      actorUserId: id(6),
      adjustmentEventId: null,
      noEffectOutcomeFactId: null,
      authorityRevocationReason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
    },
    {
      kind: 'NO_EFFECT',
      lease,
      actorUserId: id(6),
      adjustmentEventId: id(8),
      noEffectOutcomeFactId: id(12),
      authorityRevocationReason: null,
    },
  ] satisfies ChangeOrderTerminalCommand[])(
    'commits a bound $kind receipt through its sealed port',
    async (input) => {
      const f = fixture(input);
      const result = await f.adapter.record(input);
      expect(result.terminalFact).toEqual(f.terminal);
      expect(result.terminalFact.recorded_at).toBe('2026-09-06T00:01:00.123456+00:00');
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.terminalFact)).toBe(true);
      expect(f.events).toEqual(['BEGIN', 'COMMIT']);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]!.sql).toContain(
        `hxos_record_fake_financial_change_order_${input.kind.toLowerCase()}_v13`
      );
      expect(f.calls[1]!.params?.slice(0, 9)).toEqual([
        id(5),
        authority.databaseName,
        'local',
        authority.manifestDigest,
        lease.proposal_id,
        lease.recovery_lease_id,
        lease.lease_owner_id,
        lease.witness_request_sha256,
        lease.work_order_id,
      ]);
    }
  );
  it('accepts original terminal replay after lease expiry under fresh current target authority', async () => {
    const f = fixture(command, true);
    f.metadata.target_authority_id = id(30);
    f.receipt.target_authority_id = id(30);
    const result = await f.adapter.record(command);
    expect(result.idempotencyReplayed).toBe(true);
    expect(f.calls[1]!.params?.[0]).toBe(id(30));
    expect(result.terminalFact.recorded_at).toBe(f.terminal.recorded_at);
  });
  it.each([
    { proposal_id: id(99) },
    { recovery_lease_id: id(99) },
    { lease_owner_id: id(99) },
    { witness_request_sha256: 'e'.repeat(64) },
    { recorded_by: id(99) },
    { amendment_id: id(99) },
    { adjustment_event_id: id(99) },
    { capture_resume_authorized: true },
    { prior_secured_state_restored: true },
    { recorded_at: '2026-09-06T00:06:00Z' },
    { hard_assignment_created: true },
    { unexpected_authority: true },
  ])('rolls back an invalid terminal receipt %j', async (altered) => {
    const f = fixture();
    Object.assign(f.terminal, altered);
    await expect(f.adapter.record(command)).rejects.toThrow();
    expect(f.events).toEqual(['BEGIN', 'ROLLBACK']);
  });
  it.each([0, 2, null])('rejects receipt cardinality %s before commit', async (count) => {
    const f = fixture();
    f.rows(count === 0 ? [] : count === 2 ? [f.receipt, f.receipt] : [f.receipt], count as number);
    await expect(f.adapter.record(command)).rejects.toThrow('CARDINALITY');
    expect(f.events).toEqual(['BEGIN', 'ROLLBACK']);
  });
  it('rolls back a changed installed authority and surfaces uncertain commit acknowledgements', async () => {
    const f = fixture();
    f.drift(2);
    await expect(f.adapter.record(command)).rejects.toThrow('AUTHORITY_CHANGED');
    expect(f.events).toEqual(['BEGIN', 'ROLLBACK']);
    const lost = fixture();
    lost.loseCommit();
    await expect(lost.adapter.record(command)).rejects.toThrow('LOST_COMMIT_ACKNOWLEDGEMENT');
    expect(lost.events).toEqual(['BEGIN', 'COMMIT']);
  });
  it('rejects a mismatched runtime login before a terminal command', async () => {
    const f = fixture();
    f.metadata.session_database_role = 'hx_ci_api';
    await expect(f.adapter.record(command)).rejects.toThrow('TARGET_BINDING_MISMATCH');
    expect(f.calls).toHaveLength(1);
    expect(f.events).toEqual(['BEGIN', 'ROLLBACK']);
  });
  it('rejects ambiguous no-effect evidence before opening a transaction', async () => {
    const f = fixture();
    await expect(
      f.adapter.record({
        kind: 'NO_EFFECT',
        lease,
        actorUserId: id(6),
        adjustmentEventId: null,
        noEffectOutcomeFactId: id(12),
        authorityRevocationReason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      })
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
});
